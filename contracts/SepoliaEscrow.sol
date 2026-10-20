// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SepoliaEscrow
 * @notice Same-chain ETH escrow gated by a 3-of-4 listener signature threshold.
 *         The contract never trusts an off-chain consensus boolean.
 */
contract SepoliaEscrow {
    bytes32 private constant DOMAIN = keccak256("SmartListenerSepoliaEscrow:v1");
    uint256 private constant SECP256K1N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct Deposit {
        address sender;
        address recipient;
        uint256 amount;
        bytes32 payloadHash;
        uint256 deadline;
        uint256 nonce;
        bool released;
        bool refunded;
    }

    mapping(bytes32 => Deposit) public deposits;
    mapping(address => bool) public isListener;
    uint256 public immutable requiredVotes;
    uint256 public immutable listenerCount;
    uint256 private locked;

    error InvalidListenerSet();
    error InvalidDeposit();
    error DuplicateTransaction();
    error NotAuthorizedRelayer();
    error NotEnoughSignatures();
    error InvalidSignature();
    error UnauthorizedSigner();
    error DuplicateSigner();
    error TransactionAlreadySettled();
    error DeadlineNotReached();
    error NotSender();
    error TransferFailed();
    error Reentrancy();

    event Deposited(
        bytes32 indexed txId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        bytes32 payloadHash,
        uint256 deadline,
        uint256 nonce
    );
    event Released(bytes32 indexed txId, address indexed relayer, uint256 amount);
    event Refunded(bytes32 indexed txId, address indexed sender, uint256 amount);

    constructor(address[] memory listeners, uint256 threshold) {
        if (listeners.length == 0 || threshold == 0 || threshold > listeners.length) {
            revert InvalidListenerSet();
        }
        requiredVotes = threshold;
        listenerCount = listeners.length;
        for (uint256 i = 0; i < listeners.length; i++) {
            if (listeners[i] == address(0) || isListener[listeners[i]]) revert InvalidListenerSet();
            isListener[listeners[i]] = true;
        }
    }

    function deposit(
        bytes32 txId,
        address recipient,
        bytes32 payloadHash,
        uint256 deadline,
        uint256 nonce
    ) external payable {
        if (txId == bytes32(0) || recipient == address(0) || msg.value == 0 || payloadHash == bytes32(0)) {
            revert InvalidDeposit();
        }
        if (deadline <= block.timestamp) revert InvalidDeposit();
        if (deposits[txId].sender != address(0)) revert DuplicateTransaction();
        deposits[txId] = Deposit(msg.sender, recipient, msg.value, payloadHash, deadline, nonce, false, false);
        emit Deposited(txId, msg.sender, recipient, msg.value, payloadHash, deadline, nonce);
    }

    function digest(bytes32 txId) public view returns (bytes32) {
        Deposit memory d = deposits[txId];
        return keccak256(abi.encode(
            DOMAIN,
            address(this),
            block.chainid,
            txId,
            d.sender,
            d.recipient,
            d.amount,
            d.payloadHash,
            d.deadline,
            d.nonce
        ));
    }

    function release(bytes32 txId, bytes[] calldata signatures) external nonReentrant {
        if (!isListener[msg.sender]) revert NotAuthorizedRelayer();
        Deposit storage d = deposits[txId];
        if (d.sender == address(0) || d.released || d.refunded) revert TransactionAlreadySettled();
        if (block.timestamp > d.deadline) revert DeadlineNotReached();
        _verify(digest(txId), signatures);
        d.released = true;
        (bool ok, ) = payable(d.recipient).call{value: d.amount}("");
        if (!ok) revert TransferFailed();
        emit Released(txId, msg.sender, d.amount);
    }

    function refund(bytes32 txId) external nonReentrant {
        Deposit storage d = deposits[txId];
        if (d.sender == address(0) || d.released || d.refunded) revert TransactionAlreadySettled();
        if (msg.sender != d.sender) revert NotSender();
        if (block.timestamp <= d.deadline) revert DeadlineNotReached();
        d.refunded = true;
        (bool ok, ) = payable(d.sender).call{value: d.amount}("");
        if (!ok) revert TransferFailed();
        emit Refunded(txId, d.sender, d.amount);
    }

    function _verify(bytes32 messageDigest, bytes[] calldata signatures) private view {
        if (signatures.length < requiredVotes) revert NotEnoughSignatures();
        address[] memory seen = new address[](signatures.length);
        uint256 valid;
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = _recover(messageDigest, signatures[i]);
            if (!isListener[signer]) revert UnauthorizedSigner();
            for (uint256 j = 0; j < valid; j++) {
                if (seen[j] == signer) revert DuplicateSigner();
            }
            seen[valid++] = signer;
        }
        if (valid < requiredVotes) revert NotEnoughSignatures();
    }

    function _recover(bytes32 hash, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if ((v != 27 && v != 28) || uint256(s) > SECP256K1N_HALF) revert InvalidSignature();
        signer = ecrecover(hash, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }

    modifier nonReentrant() {
        if (locked == 1) revert Reentrancy();
        locked = 1;
        _;
        locked = 0;
    }
}
