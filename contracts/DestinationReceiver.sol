// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title DestinationReceiver
 * @notice Real destination-chain contract (Step 1). Executes an approved cross-chain
 *         payload ONCE per source txId and emits InterChainCompleted, which the
 *         source side can read back to confirm completion.
 *
 * @dev Any address in the executor set (one per Smart Listener node) may call execute().
 *      Replay protection: a txId can only ever be executed once.
 */
contract DestinationReceiver {
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
    uint256 public executedCount;

    error NotExecutor();
    error AlreadyExecuted();
    error EmptyPayload();
    error InvalidRecipient();
    error InsufficientReserve();
    error TransferFailed();

    constructor(address[] memory executors) {
        for (uint256 i = 0; i < executors.length; i++) {
            isExecutor[executors[i]] = true;
        }
    }

    function execute(bytes32 sourceTxId, bytes calldata payload) external {
        if (!isExecutor[msg.sender]) revert NotExecutor();
        if (executed[sourceTxId]) revert AlreadyExecuted();
        if (payload.length == 0) revert EmptyPayload();

        executed[sourceTxId] = true;
        unchecked { executedCount++; }

        emit InterChainCompleted(sourceTxId, msg.sender, keccak256(payload), block.timestamp, address(0), 0);
    }

    function executeValue(
        bytes32 sourceTxId,
        address recipient,
        bytes calldata payload,
        uint256 amount
    ) external {
        if (!isExecutor[msg.sender]) revert NotExecutor();
        if (executed[sourceTxId]) revert AlreadyExecuted();
        if (recipient == address(0)) revert InvalidRecipient();
        if (payload.length == 0) revert EmptyPayload();
        if (amount == 0 || address(this).balance < amount) revert InsufficientReserve();

        executed[sourceTxId] = true;
        unchecked { executedCount++; }
        (bool ok, ) = payable(recipient).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit InterChainCompleted(sourceTxId, msg.sender, keccak256(payload), block.timestamp, recipient, amount);
    }

    function wasExecuted(bytes32 txId) external view returns (bool) {
        return executed[txId];
    }

    receive() external payable {}
}
