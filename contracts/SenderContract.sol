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
        uint256 timestamp
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

    // ── Errors ────────────────────────────────────────────────────────────────

    error ContractPaused();
    error EmptyDestinationAddress();
    error EmptyPayload();
    error NotTxSender();
    error TxAlreadyCancelled();

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
    ) external whenNotPaused returns (bytes32 txId) {
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
                block.chainid
            )
        );

        txSenders[txId] = msg.sender;

        emit TransactionSent(
            txId,
            msg.sender,
            destinationChainId,
            destinationAddress,
            payload,
            nonce,
            block.timestamp
        );
    }

    /**
     * @notice Cancel an unexecuted tx (signal only — off-chain Listeners honour this).
     */
    function cancelTransaction(bytes32 txId) external {
        if (txSenders[txId] != msg.sender) revert NotTxSender();
        if (txSenders[txId] == address(0)) revert TxAlreadyCancelled();

        delete txSenders[txId];
        emit TransactionCancelled(txId, msg.sender);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
    }

    // ── View ──────────────────────────────────────────────────────────────────

    function getNonce(address sender) external view returns (uint256) {
        return nonces[sender];
    }
}
