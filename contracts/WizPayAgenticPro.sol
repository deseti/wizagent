// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function approve(address spender, uint256 amount) external returns (bool);

    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IStableFXAdapter {
    function getEstimatedAmount(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view returns (uint256 estimatedAmountOut);

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to
    ) external returns (uint256 amountOut);
}

contract WizPayAgenticPro {
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_BATCH_SIZE = 50;

    error BatchTooLarge(uint256 provided, uint256 maximum);
    error EmptyBatch();
    error FeeBpsTooHigh(uint256 provided);
    error InvalidArrayLength(uint256 agentsLength, uint256 taskHashesLength);
    error InvalidSlippageBps(uint256 provided);
    error InvalidTreasuryRoute(address provided, address expected);
    error NotOwner(address caller);
    error ReentrancyAttempt();
    error ZeroSwapQuote();
    error TaskAlreadyPaid(bytes32 taskHash);
    error DuplicateTaskHash(bytes32 taskHash);
    error TokenOperationFailed(address token);
    error ZeroAddress();
    error ZeroPaymentAmount();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event TreasuryFeeUpdated(uint256 previousFeeBps, uint256 newFeeBps);
    event AgentSettlementPreferenceUpdated(address indexed agent, bool requiresEurc);
    event AgentPaid(
        bytes32 indexed taskHash,
        address indexed payer,
        address indexed agent,
        address settlementToken,
        uint256 settlementAmount,
        uint256 treasuryFee
    );
    event BatchPaymentExecuted(
        address indexed payer,
        uint256 agentCount,
        uint256 totalUsdcCharged,
        uint256 swapCount,
        uint256 treasuryFeeTotal
    );

    IERC20Minimal public immutable usdc;
    IERC20Minimal public immutable eurc;
    IStableFXAdapter public immutable stableFxAdapter;
    uint256 public immutable paymentAmount;
    uint256 public immutable maxSlippageBps;

    address public owner;
    address public treasury;
    uint256 public treasuryFeeBps;

    mapping(bytes32 => bool) public paidTaskHashes;
    mapping(address => bool) public agentRequiresEurc;

    uint256 private _reentrancyLock = 1;

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert NotOwner(msg.sender);
        }
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyLock != 1) {
            revert ReentrancyAttempt();
        }

        _reentrancyLock = 2;
        _;
        _reentrancyLock = 1;
    }

    constructor(
        address owner_,
        address usdc_,
        address eurc_,
        address stableFxAdapter_,
        address treasury_,
        uint256 paymentAmount_,
        uint256 treasuryFeeBps_,
        uint256 maxSlippageBps_
    ) {
        if (
            owner_ == address(0) ||
            usdc_ == address(0) ||
            eurc_ == address(0) ||
            stableFxAdapter_ == address(0) ||
            treasury_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (paymentAmount_ == 0) {
            revert ZeroPaymentAmount();
        }
        if (treasuryFeeBps_ > BPS_DENOMINATOR) {
            revert FeeBpsTooHigh(treasuryFeeBps_);
        }
        if (maxSlippageBps_ > BPS_DENOMINATOR) {
            revert InvalidSlippageBps(maxSlippageBps_);
        }

        owner = owner_;
        usdc = IERC20Minimal(usdc_);
        eurc = IERC20Minimal(eurc_);
        stableFxAdapter = IStableFXAdapter(stableFxAdapter_);
        treasury = treasury_;
        paymentAmount = paymentAmount_;
        treasuryFeeBps = treasuryFeeBps_;
        maxSlippageBps = maxSlippageBps_;

        emit OwnershipTransferred(address(0), owner_);
        emit TreasuryUpdated(address(0), treasury_);
        emit TreasuryFeeUpdated(0, treasuryFeeBps_);
    }

    function batchPayAgents(
        address[] calldata agents,
        bytes32[] calldata taskHashes,
        address _treasury
    ) external nonReentrant returns (uint256 totalUsdcCharged, uint256 treasuryFeeTotal) {
        uint256 agentCount = agents.length;
        if (agentCount == 0) {
            revert EmptyBatch();
        }
        if (agentCount != taskHashes.length) {
            revert InvalidArrayLength(agentCount, taskHashes.length);
        }
        if (agentCount > MAX_BATCH_SIZE) {
            revert BatchTooLarge(agentCount, MAX_BATCH_SIZE);
        }

        uint256 swapCount;
        for (uint256 i = 0; i < agentCount; ++i) {
            bytes32 taskHash = taskHashes[i];
            if (paidTaskHashes[taskHash]) {
                revert TaskAlreadyPaid(taskHash);
            }

            for (uint256 j = i + 1; j < agentCount; ++j) {
                if (taskHash == taskHashes[j]) {
                    revert DuplicateTaskHash(taskHash);
                }
            }

            if (agents[i] == address(0)) {
                revert ZeroAddress();
            }

            if (agentRequiresEurc[agents[i]]) {
                unchecked {
                    ++swapCount;
                }
            }
        }

        treasuryFeeTotal = (swapCount * paymentAmount * treasuryFeeBps) / BPS_DENOMINATOR;
        totalUsdcCharged = (agentCount * paymentAmount) + treasuryFeeTotal;

        _safeTransferFrom(usdc, msg.sender, address(this), totalUsdcCharged);

        if (treasuryFeeTotal != 0) {
            address payoutTreasury = treasury;
            if (payoutTreasury == address(0)) {
                revert ZeroAddress();
            }
            if (_treasury != address(0) && _treasury != payoutTreasury) {
                revert InvalidTreasuryRoute(_treasury, payoutTreasury);
            }

            _safeTransfer(usdc, payoutTreasury, treasuryFeeTotal);
        }

        uint256 minAmountOut;
        uint256 totalSwapAmount = swapCount * paymentAmount;
        if (swapCount != 0) {
            uint256 estimatedAmountOut = stableFxAdapter.getEstimatedAmount(
                address(usdc),
                address(eurc),
                paymentAmount
            );
            if (estimatedAmountOut == 0) {
                revert ZeroSwapQuote();
            }
            minAmountOut = (estimatedAmountOut * (BPS_DENOMINATOR - maxSlippageBps)) /
                BPS_DENOMINATOR;

            _forceApprove(usdc, address(stableFxAdapter), totalSwapAmount);
        }

        for (uint256 i = 0; i < agentCount; ++i) {
            address agent = agents[i];
            bytes32 taskHash = taskHashes[i];
            paidTaskHashes[taskHash] = true;

            if (agentRequiresEurc[agent]) {
                uint256 amountOut = stableFxAdapter.swap(
                    address(usdc),
                    address(eurc),
                    paymentAmount,
                    minAmountOut,
                    agent
                );

                emit AgentPaid(
                    taskHash,
                    msg.sender,
                    agent,
                    address(eurc),
                    amountOut,
                    (paymentAmount * treasuryFeeBps) / BPS_DENOMINATOR
                );
            } else {
                _safeTransfer(usdc, agent, paymentAmount);

                emit AgentPaid(
                    taskHash,
                    msg.sender,
                    agent,
                    address(usdc),
                    paymentAmount,
                    0
                );
            }
        }

        if (swapCount != 0) {
            _forceApprove(usdc, address(stableFxAdapter), 0);
        }

        emit BatchPaymentExecuted(
            msg.sender,
            agentCount,
            totalUsdcCharged,
            swapCount,
            treasuryFeeTotal
        );
    }

    function previewBatchCost(
        address[] calldata agents
    ) external view returns (uint256 totalUsdcCharge, uint256 swapCount, uint256 treasuryFeeTotal) {
        uint256 agentCount = agents.length;
        if (agentCount == 0) {
            return (0, 0, 0);
        }
        if (agentCount > MAX_BATCH_SIZE) {
            revert BatchTooLarge(agentCount, MAX_BATCH_SIZE);
        }

        for (uint256 i = 0; i < agentCount; ++i) {
            if (agentRequiresEurc[agents[i]]) {
                unchecked {
                    ++swapCount;
                }
            }
        }

        treasuryFeeTotal = (swapCount * paymentAmount * treasuryFeeBps) / BPS_DENOMINATOR;
        totalUsdcCharge = (agentCount * paymentAmount) + treasuryFeeTotal;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) {
            revert ZeroAddress();
        }

        address previousOwner = owner;
        owner = newOwner;

        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) {
            revert ZeroAddress();
        }

        address previousTreasury = treasury;
        treasury = newTreasury;

        emit TreasuryUpdated(previousTreasury, newTreasury);
    }

    function setTreasuryFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > BPS_DENOMINATOR) {
            revert FeeBpsTooHigh(newFeeBps);
        }

        uint256 previousFeeBps = treasuryFeeBps;
        treasuryFeeBps = newFeeBps;

        emit TreasuryFeeUpdated(previousFeeBps, newFeeBps);
    }

    function setMySettlementPreference(bool requiresEurc) external {
        agentRequiresEurc[msg.sender] = requiresEurc;
        emit AgentSettlementPreferenceUpdated(msg.sender, requiresEurc);
    }

    function setAgentSettlementPreferences(
        address[] calldata agents,
        bool[] calldata requiresEurcFlags
    ) external onlyOwner {
        if (agents.length != requiresEurcFlags.length) {
            revert InvalidArrayLength(agents.length, requiresEurcFlags.length);
        }

        for (uint256 i = 0; i < agents.length; ++i) {
            if (agents[i] == address(0)) {
                revert ZeroAddress();
            }

            agentRequiresEurc[agents[i]] = requiresEurcFlags[i];
            emit AgentSettlementPreferenceUpdated(agents[i], requiresEurcFlags[i]);
        }
    }

    function _forceApprove(IERC20Minimal token, address spender, uint256 amount) private {
        _callOptionalReturn(token, abi.encodeCall(IERC20Minimal.approve, (spender, 0)));
        _callOptionalReturn(token, abi.encodeCall(IERC20Minimal.approve, (spender, amount)));
    }

    function _safeTransfer(IERC20Minimal token, address to, uint256 amount) private {
        _callOptionalReturn(token, abi.encodeCall(IERC20Minimal.transfer, (to, amount)));
    }

    function _safeTransferFrom(
        IERC20Minimal token,
        address from,
        address to,
        uint256 amount
    ) private {
        _callOptionalReturn(token, abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount)));
    }

    function _callOptionalReturn(IERC20Minimal token, bytes memory data) private {
        (bool success, bytes memory returndata) = address(token).call(data);
        if (!success) {
            revert TokenOperationFailed(address(token));
        }

        if (returndata.length != 0 && !abi.decode(returndata, (bool))) {
            revert TokenOperationFailed(address(token));
        }
    }
}