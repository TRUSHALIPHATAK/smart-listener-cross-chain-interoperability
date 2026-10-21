// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract DestinationReceiver {
    bytes32 private constant DOMAIN = keccak256("SmartListenerCrossChain:v1");
    bytes32 private constant TYPE_HASH = keccak256(
        "SmartListenerCrossChain(bytes32 sourceTxId,uint256 sourceChainId,uint256 destinationChainId,bytes32 destinationRouteId,address receiver,bytes32 payloadHash,address recipient,uint8 transferMode,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    event InterChainCompleted(
        bytes32 indexed sourceTxId,
        address indexed executor,
        bytes32 payloadHash,
        uint256 timestamp,
        address recipient,
        uint256 amount
    );

    mapping(address => bool) public isExecutor;
    mapping(bytes32 => bool) public executed;
    uint256 public immutable sourceChainId;
    uint256 public immutable requiredVotes;
    uint256 public executedCount;

    error NotExecutor();
    error AlreadyExecuted();
    error EmptyPayload();
    error InvalidRecipient();
    error InsufficientReserve();
    error TransferFailed();
    error ExpiredDeadline();
    error InvalidSignature();
    error UnauthorizedSigner();
    error DuplicateSigner();
    error InsufficientSignatures();
    error InvalidDestinationChain();
    error InvalidConfiguration();

    constructor(address[] memory executors, uint256 sourceChain, uint256 threshold) {
        if (executors.length == 0 || threshold == 0 || threshold > executors.length || threshold <= executors.length / 2) {
            revert InvalidConfiguration();
        }
        sourceChainId = sourceChain;
        requiredVotes = threshold;
        for (uint256 i = 0; i < executors.length; i++) {
            if (executors[i] == address(0)) revert InvalidConfiguration();
            isExecutor[executors[i]] = true;
        }
    }

    function digest(
        bytes32 sourceTxId,
        bytes32 destinationChainId,
        bytes32 payloadHash,
        address recipient,
        uint8 transferMode,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN,
            TYPE_HASH,
            sourceChainId,
            sourceTxId,
            block.chainid,
            destinationChainId,
            address(this),
            payloadHash,
            recipient,
            transferMode,
            amount,
            nonce,
            deadline
        ));
    }

    function _verify(
        bytes32 messageDigest,
        bytes[] calldata signatures
    ) internal view {
        if (signatures.length < requiredVotes) revert InsufficientSignatures();
        address[] memory seen = new address[](signatures.length);
        uint256 valid;
        for (uint256 i = 0; i < signatures.length; i++) {
            (address signer, ECDSARecoverError err) = _recover(messageDigest, signatures[i]);
            if (err != ECDSARecoverError.NoError) revert InvalidSignature();
            if (!isExecutor[signer]) revert UnauthorizedSigner();
            for (uint256 j = 0; j < valid; j++) if (seen[j] == signer) revert DuplicateSigner();
            seen[valid++] = signer;
        }
        if (valid < requiredVotes) revert InsufficientSignatures();
    }

    enum ECDSARecoverError { NoError, InvalidSignature }
    function _recover(bytes32 hash, bytes calldata signature)
        private pure returns (address, ECDSARecoverError)
    {
        if (signature.length != 65) return (address(0), ECDSARecoverError.InvalidSignature);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return (address(0), ECDSARecoverError.InvalidSignature);
        // Reject malleable signatures (secp256k1 half-order rule).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return (address(0), ECDSARecoverError.InvalidSignature);
        }
        address signer = ecrecover(hash, v, r, s);
        if (signer == address(0)) return (address(0), ECDSARecoverError.InvalidSignature);
        return (signer, ECDSARecoverError.NoError);
    }

    function execute(
        bytes32 sourceTxId,
        bytes32 destinationChainId,
        bytes calldata payload,
        uint256 nonce,
        uint256 deadline,
        bytes[] calldata signatures
    ) external {
        _execute(sourceTxId, destinationChainId, address(0), payload, 0, 0, nonce, deadline, signatures);
    }

    function executeValue(
        bytes32 sourceTxId,
        bytes32 destinationChainId,
        address recipient,
        bytes calldata payload,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes[] calldata signatures
    ) external {
        _execute(sourceTxId, destinationChainId, recipient, payload, 1, amount, nonce, deadline, signatures);
    }

    function _execute(
        bytes32 sourceTxId,
        bytes32 destinationChainId,
        address recipient,
        bytes calldata payload,
        uint8 transferMode,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes[] calldata signatures
    ) private {
        if (!isExecutor[msg.sender]) revert NotExecutor();
        if (executed[sourceTxId]) revert AlreadyExecuted();
        if (payload.length == 0) revert EmptyPayload();
        if (deadline < block.timestamp) revert ExpiredDeadline();
        bytes32 messageDigest = digest(sourceTxId, destinationChainId, keccak256(payload), recipient, transferMode, amount, nonce, deadline);
        _verify(messageDigest, signatures);
        if (transferMode == 1) {
            if (recipient == address(0)) revert InvalidRecipient();
            if (amount == 0 || address(this).balance < amount) revert InsufficientReserve();
        }
        executed[sourceTxId] = true;
        unchecked { executedCount++; }
        if (transferMode == 1) {
            (bool ok, ) = payable(recipient).call{value: amount}("");
            if (!ok) revert TransferFailed();
        }
        emit InterChainCompleted(sourceTxId, msg.sender, keccak256(payload), block.timestamp, recipient, amount);
    }

    function wasExecuted(bytes32 txId) external view returns (bool) { return executed[txId]; }
    receive() external payable {}
}
