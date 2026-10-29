// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title DemoCoin
 * @notice Minimal ERC-20 with EIP-3009 (transferWithAuthorization) for the x402 demo.
 * @dev Replaces the vendored FiatTokenV2_2, whose ~23KB runtime no longer fits under
 * Sepolia's per-transaction gas cap. Keeps only what the Facilitator needs:
 * ERC-20 + EIP-712 domain (version "1") + EIP-3009, plus owner-only minting.
 */
contract DemoCoin {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    address public owner;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // EIP-3009
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    // EIP-712, cached for the deployment chain and recomputed after a fork
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private immutable _nameHash;
    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;

    // secp256k1n / 2, upper bound for non-malleable signatures
    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientAllowance();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error CallerMustBePayee();
    error InvalidSignature();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);

        _nameHash = keccak256(bytes(name_));
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    // ---------------------------------------------------------------- ERC-20

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - value;
            }
        }
        _transfer(from, to, value);
        return true;
    }

    // ---------------------------------------------------------------- Owner

    function mint(address to, uint256 value) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += value;
        unchecked {
            balanceOf[to] += value;
        }
        emit Transfer(address(0), to, value);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ---------------------------------------------------------------- EIP-712

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, _nameHash, VERSION_HASH, block.chainid, address(this)));
    }

    // ---------------------------------------------------------------- EIP-3009

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _transferWithAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s
        );
    }

    /// @dev Packed 65-byte signature variant, matching FiatTokenV2_2's overload.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        (uint8 v, bytes32 r, bytes32 s) = _splitSignature(signature);
        _transferWithAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s
        );
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _transferWithAuthorization(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s
        );
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed();
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        _requireValidSignature(authorizer, structHash, v, r, s);
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _transferWithAuthorization(
        bytes32 typeHash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationStates[from][nonce]) revert AuthorizationAlreadyUsed();

        bytes32 structHash = keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce));
        _requireValidSignature(from, structHash, v, r, s);

        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    // ---------------------------------------------------------------- Internals

    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert ZeroAddress();
        uint256 fromBalance = balanceOf[from];
        if (fromBalance < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = fromBalance - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }

    function _requireValidSignature(address signer, bytes32 structHash, uint8 v, bytes32 r, bytes32 s) private view {
        if (uint256(s) > HALF_ORDER || (v != 27 && v != 28)) revert InvalidSignature();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != signer) revert InvalidSignature();
    }

    function _splitSignature(bytes calldata signature) private pure returns (uint8 v, bytes32 r, bytes32 s) {
        if (signature.length != 65) revert InvalidSignature();
        r = bytes32(signature[0:32]);
        s = bytes32(signature[32:64]);
        v = uint8(signature[64]);
    }
}
