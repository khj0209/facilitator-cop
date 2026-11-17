// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DemoCoin} from "../contracts/demo/DemoCoin.sol";

contract DemoCoinTest is Test {
    DemoCoin coin;
    address owner = makeAddr("owner");
    uint256 payerKey = 0xA11CE;
    address payer;
    address payee = makeAddr("payee");
    address facilitator = makeAddr("facilitator");

    function setUp() public {
        payer = vm.addr(payerKey);
        coin = new DemoCoin("DemoCoin", "DEMO", 6, owner);
        vm.prank(owner);
        coin.mint(payer, 1_000_000);
        vm.warp(1_000);
    }

    function _sign(uint256 key, bytes32 structHash) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", coin.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(key, digest);
    }

    function _authHash(bytes32 typeHash, uint256 value, bytes32 nonce) internal view returns (bytes32) {
        return keccak256(abi.encode(typeHash, payer, payee, value, uint256(0), uint256(2_000), nonce));
    }

    function test_DomainSeparatorMatchesEip712() public {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("DemoCoin"),
                keccak256("1"),
                block.chainid,
                address(coin)
            )
        );
        assertEq(coin.DOMAIN_SEPARATOR(), expected);
    }

    function test_TransferWithAuthorization_FacilitatorPaysGas() public {
        bytes32 nonce = keccak256("n1");
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, _authHash(coin.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), 1_000, nonce));

        vm.prank(facilitator);
        coin.transferWithAuthorization(payer, payee, 1_000, 0, 2_000, nonce, v, r, s);

        assertEq(coin.balanceOf(payee), 1_000);
        assertEq(coin.balanceOf(payer), 999_000);
        assertTrue(coin.authorizationState(payer, nonce));
    }

    function test_TransferWithAuthorization_PackedSignature() public {
        bytes32 nonce = keccak256("n2");
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, _authHash(coin.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), 500, nonce));

        coin.transferWithAuthorization(payer, payee, 500, 0, 2_000, nonce, abi.encodePacked(r, s, v));
        assertEq(coin.balanceOf(payee), 500);
    }

    function test_RevertWhen_NonceReused() public {
        bytes32 nonce = keccak256("n3");
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, _authHash(coin.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), 1, nonce));
        coin.transferWithAuthorization(payer, payee, 1, 0, 2_000, nonce, v, r, s);

        vm.expectRevert(DemoCoin.AuthorizationAlreadyUsed.selector);
        coin.transferWithAuthorization(payer, payee, 1, 0, 2_000, nonce, v, r, s);
    }

    function test_RevertWhen_Expired() public {
        bytes32 nonce = keccak256("n4");
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, _authHash(coin.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), 1, nonce));
        vm.warp(2_000);
        vm.expectRevert(DemoCoin.AuthorizationExpired.selector);
        coin.transferWithAuthorization(payer, payee, 1, 0, 2_000, nonce, v, r, s);
    }

    function test_RevertWhen_AmountTampered() public {
        bytes32 nonce = keccak256("n5");
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, _authHash(coin.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), 1, nonce));
        vm.expectRevert(DemoCoin.InvalidSignature.selector);
        coin.transferWithAuthorization(payer, payee, 999, 0, 2_000, nonce, v, r, s);
    }

    function test_RevertWhen_WrongSigner() public {
        bytes32 nonce = keccak256("n6");
        (uint8 v, bytes32 r, bytes32 s) = _sign(0xB0B, _authHash(coin.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), 1, nonce));
        vm.expectRevert(DemoCoin.InvalidSignature.selector);
        coin.transferWithAuthorization(payer, payee, 1, 0, 2_000, nonce, v, r, s);
    }

    function test_ReceiveWithAuthorization_OnlyPayee() public {
        bytes32 nonce = keccak256("n7");
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, _authHash(coin.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), 10, nonce));

        vm.prank(facilitator);
        vm.expectRevert(DemoCoin.CallerMustBePayee.selector);
        coin.receiveWithAuthorization(payer, payee, 10, 0, 2_000, nonce, v, r, s);

        vm.prank(payee);
        coin.receiveWithAuthorization(payer, payee, 10, 0, 2_000, nonce, v, r, s);
        assertEq(coin.balanceOf(payee), 10);
    }

    function test_CancelAuthorization() public {
        bytes32 nonce = keccak256("n8");
        bytes32 cancelHash = keccak256(abi.encode(coin.CANCEL_AUTHORIZATION_TYPEHASH(), payer, nonce));
        (uint8 cv, bytes32 cr, bytes32 cs) = _sign(payerKey, cancelHash);
        coin.cancelAuthorization(payer, nonce, cv, cr, cs);

        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, _authHash(coin.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), 1, nonce));
        vm.expectRevert(DemoCoin.AuthorizationAlreadyUsed.selector);
        coin.transferWithAuthorization(payer, payee, 1, 0, 2_000, nonce, v, r, s);
    }

    function test_RevertWhen_NonOwnerMints() public {
        vm.expectRevert(DemoCoin.NotOwner.selector);
        coin.mint(payer, 1);
    }
}
