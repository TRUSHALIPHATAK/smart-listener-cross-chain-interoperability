// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SenderContract
 * @notice Source-chain contract for the Smart Listener cross-chain protocol.
 *         Emits a `TransactionSent` event that the three independent off-chain
 *         Smart Listeners monitor and vote on (2-of-3 approval required).
 *
 * @dev This contract intentionally does NOT guarantee atomic cross-chain
 *      delivery or rollback. The Listeners provide best-effort, optimistic
 *      transfer with majority-vote validation.
 */
contract SenderContract {
    // ── Events ───────────────────────────────────────────────────────────────

    /**
     * @notice Emitted when a cross-chain transfer is requested.
     * @param txId          Unique transaction identifier (keccak256 of sender+nonce+timestamp)
     * @param sender        Address that initiated the transfer
     * @param destinationChainId  Target chain identifier (e.g., Fabric channel name hash)
     * @param destinationAddress  Encoded recipient on the destination chain
     * @param payload       ABI-encoded call data / token transfer data
     * @param nonce         Per-sender nonce for replay protection
     * @param timestamp     Block timestamp of the request
     */
    event TransactionSent(
        bytes32 indexed txId,
        address indexed sender,
        bytes32 indexed destinationChainId,
        bytes   destinationAddress,
        bytes   payload,
        uint256 nonce,
        uint256 timestamp,
        uint256 amount,
        uint256 deadline
    );

    /**
     * @notice Emitted when a previously submitted tx is cancelled by its sender.
     */
    event TransactionCancelled(bytes32 indexed txId, address indexed sender);

    // ── State ─────────────────────────────────────────────────────────────────

    /// @notice Nonce per sender (prevents replay at source layer)
    mapping(address => uint256) public nonces;

    /// @notice Owner of the contract (can pause in emergency)
    address public immutable owner;

    /// @notice Whether the contract is paused
    bool public paused;

    /// @notice txId → sender (for cancel validation)
    mapping(bytes32 => address) public txSenders;
    mapping(bytes32 => uint256) public txAmounts;
    mapping(bytes32 => uint256) public txSubmittedAt;
    mapping(bytes32 => bool) public txFinalized;
    mapping(bytes32 => bool) public txRefunded;
    mapping(bytes32 => bool) public txRolledBack;

    event TransactionRolledBack(bytes32 indexed txId, address indexed sender, uint256 amount);

    // ── Errors ────────────────────────────────────────────────────────────────

    error ContractPaused();
    error EmptyDestinationAddress();
    error EmptyPayload();
    error NotTxSender();
    error TxAlreadyCancelled();
    error InvalidAmount();
    error NotFinalizable();
    error RefundTooEarly();
    error TransferFailed();
    error RollbackTooEarly();

    uint256 public constant REFUND_DELAY = 60 seconds;
    uint256 public constant DEADLINE_WINDOW = 1 hours;

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "SenderContract: not owner");
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    // ── External Functions ────────────────────────────────────────────────────

    /**
     * @notice Initiates a cross-chain transfer.
     * @param destinationChainId  Target chain ID (arbitrary bytes32 agreed with Listeners)
     * @param destinationAddress  Encoded address / channel / key on destination
     * @param payload             ABI-encoded payload for the destination contract
     * @return txId               The unique transaction ID
     */
    function sendCrossChainTransaction(
        bytes32 destinationChainId,
        bytes calldata destinationAddress,
        bytes calldata payload
    ) external payable whenNotPaused returns (bytes32 txId) {
        if (destinationAddress.length == 0) revert EmptyDestinationAddress();
        if (payload.length == 0) revert EmptyPayload();

        uint256 nonce = nonces[msg.sender]++;

        txId = keccak256(
            abi.encodePacked(
                msg.sender,
                nonce,
                block.timestamp,
                destinationChainId,
                destinationAddress,
                payload,
                msg.value,
                block.chainid
            )
        );

        txSenders[txId] = msg.sender;
        txAmounts[txId] = msg.value;
        txSubmittedAt[txId] = block.timestamp;

        emit TransactionSent(
            txId,
            msg.sender,
            destinationChainId,
            destinationAddress,
            payload,
            nonce,
            block.timestamp,
            msg.value,
            block.timestamp + DEADLINE_WINDOW
        );
    }

    /**
     * @notice Cancel an unexecuted tx (signal only — off-chain Listeners honour this).
     */
    function cancelTransaction(bytes32 txId) external {
        if (txSenders[txId] != msg.sender) revert NotTxSender();
        if (txFinalized[txId] || txRefunded[txId]) revert TxAlreadyCancelled();

        uint256 amount = txAmounts[txId];
        delete txSenders[txId];
        txRefunded[txId] = true;
        if (amount > 0) {
            (bool ok, ) = payable(msg.sender).call{value: amount}("");
            if (!ok) revert TransferFailed();
        }
        emit TransactionCancelled(txId, msg.sender);
    }

    function finalizeTransaction(bytes32 txId) external onlyOwner {
        address sender = txSenders[txId];
        if (sender == address(0) || txFinalized[txId] || txRefunded[txId]) revert NotFinalizable();
        uint256 amount = txAmounts[txId];
        txFinalized[txId] = true;
        delete txSenders[txId];
        if (amount > 0) {
            (bool ok, ) = payable(owner).call{value: amount}("");
            if (!ok) revert TransferFailed();
        }
    }

    function refundTransaction(bytes32 txId) external {
        address sender = txSenders[txId];
        if (sender != msg.sender) revert NotTxSender();
        if (txFinalized[txId] || txRefunded[txId]) revert TxAlreadyCancelled();
        if (block.timestamp < txSubmittedAt[txId] + REFUND_DELAY) revert RefundTooEarly();
        uint256 amount = txAmounts[txId];
        txRefunded[txId] = true;
        delete txSenders[txId];
        if (amount > 0) {
            (bool ok, ) = payable(msg.sender).call{value: amount}("");
            if (!ok) revert TransferFailed();
        }
    }

    /**
     * @notice Owner-coordinated settlement after the backup window expires.
     *         This is idempotent once rollback has completed and never touches
     *         an escrow that was finalized or refunded.
     */
    function rollbackTransaction(bytes32 txId) external onlyOwner {
        if (txRolledBack[txId]) return;
        address sender = txSenders[txId];
        if (sender == address(0) || txFinalized[txId] || txRefunded[txId]) revert NotFinalizable();
        if (block.timestamp < txSubmittedAt[txId] + REFUND_DELAY) revert RollbackTooEarly();

        uint256 amount = txAmounts[txId];
        txRolledBack[txId] = true;
        delete txSenders[txId];
        if (amount > 0) {
            (bool ok, ) = payable(sender).call{value: amount}("");
            if (!ok) revert TransferFailed();
        }
        emit TransactionRolledBack(txId, sender, amount);
    }

    receive() external payable {}

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
    }

    // ── View ──────────────────────────────────────────────────────────────────

    function getNonce(address sender) external view returns (uint256) {
        return nonces[sender];
    }
}
