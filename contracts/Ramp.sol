// SPDX-License-Identifier: MIT
pragma solidity ^0.8.12;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { Verifier } from "./Verifier.sol";


contract Ramp is Verifier, Ownable {
    
    /* ============ Enums ============ */

    enum OrderStatus {
        Unopened,
        Open,
        Filled,
        Canceled
    }

    enum ClaimStatus {
        Unsubmitted,
        Submitted,
        Used,
        Clawback
    }
    
    /* ============ Structs ============ */

    struct Order {
        address onRamper;
        bytes onRamperEncryptPublicKey;
        uint256 amountToReceive;
        uint256 maxAmountToPay;
        OrderStatus status;
    }

    struct OrderClaim {
        address offRamper;
        uint256 venmoId;                        // hash of offRamperVenmoId
        ClaimStatus status;
        bytes encryptedOffRamperVenmoId;        // encrypt(offRamperVenmoId, onRamperEncryptPublicKey)
        uint256 claimExpirationTime;
        uint256 minAmountToPay;
    }

    struct OrderWithId {
        uint256 id;
        Order order;
    }

    /* ============ Modifiers ============ */

    /* ============ Public Variables ============ */

    uint256 private constant rsaModulusChunksLen = 17;
    uint16 private constant msgLen = 26;
    uint16 private constant bytesInPackedBytes = 7;  // 7 bytes in a packed item returned from circom

    /* ============ Public Variables ============ */

    // Max value for the order amount, claim amount, and off-chain transaction amount
    uint256 public maxAmount;

    IERC20 public immutable usdc;
    uint256[rsaModulusChunksLen] public venmoMailserverKeys;

    uint256 public orderNonce;
    mapping(uint256=>uint256) public orderClaimNonce;

    mapping(uint256=>Order) public orders;
    mapping(uint256=>mapping(uint256=>bool)) public orderClaimedByVenmoId;
    mapping(uint256=>mapping(uint256=>OrderClaim)) public orderClaims;

    mapping(bytes32 => bool) public nullified;

    /* ============ External Functions ============ */

    constructor(uint256[rsaModulusChunksLen] memory _venmoMailserverKeys, IERC20 _usdc, uint256 _maxAmount) {
        venmoMailserverKeys = _venmoMailserverKeys;
        usdc = _usdc;
        maxAmount = _maxAmount;

        orderNonce = 1;
    }

    /* ============ Admin Functions ============ */

    function setMaxAmount(uint256 _maxAmount) external onlyOwner {
        maxAmount = _maxAmount;
    }

    function setVenmoMailserverKeys(uint256[rsaModulusChunksLen] memory _venmoMailserverKeys) external onlyOwner {
        venmoMailserverKeys = _venmoMailserverKeys;
    }

    /* ============ External Functions ============ */


    function postOrder(uint256 _amount, uint256 _maxAmountToPay, bytes calldata _encryptPublicKey) 
        external 
    {
        require(_amount != 0, "Amount can't be 0");
        require(_amount <= maxAmount, "Amount can't be greater than max amount");
        require(_maxAmountToPay != 0, "Max amount can't be 0");
        require(_maxAmountToPay <= maxAmount, "Max amount can't be greater than max amount");
        
        Order memory order = Order({
            onRamper: msg.sender,
            onRamperEncryptPublicKey: _encryptPublicKey,
            amountToReceive: _amount,
            maxAmountToPay: _maxAmountToPay,
            status: OrderStatus.Open
        });

        orders[orderNonce] = order;
        orderNonce++;

        // Todo: Can return order id for the on-ramper to know their order id.
    }

    function claimOrder(
        uint256 _venmoId,
        uint256 _orderNonce,
        bytes calldata _encryptedVenmoId,
        uint256 _minAmountToPay
    )
        external 
    {
        require(orders[_orderNonce].status == OrderStatus.Open, "Order has already been filled, canceled, or doesn't exist");
        require(!orderClaimedByVenmoId[_orderNonce][_venmoId], "Order has already been claimed by Venmo ID");
        // Todo: This can be sybilled. What are the implications of this?
        require(msg.sender != orders[_orderNonce].onRamper, "Can't claim your own order");
        
        require(_minAmountToPay != 0, "Min amount to pay can't be 0");
        require(_minAmountToPay <= orders[_orderNonce].maxAmountToPay, "Min amount to pay can't be greater than max amount to pay");

        OrderClaim memory claim = OrderClaim({
            offRamper: msg.sender,
            venmoId: _venmoId,
            encryptedOffRamperVenmoId: _encryptedVenmoId,
            minAmountToPay: _minAmountToPay,
            status: ClaimStatus.Submitted,
            claimExpirationTime: block.timestamp + 1 days
        });

        uint256 claimNonce = orderClaimNonce[_orderNonce];
        orderClaims[_orderNonce][claimNonce] = claim;
        orderClaimNonce[_orderNonce] = claimNonce + 1;

        orderClaimedByVenmoId[_orderNonce][_venmoId] = true;

        usdc.transferFrom(msg.sender, address(this), orders[_orderNonce].amountToReceive);
    }

    function onRamp(
        uint256[2] memory _a,
        uint256[2][2] memory _b,
        uint256[2] memory _c,
        uint256[msgLen] memory _signals
    )
        external
    {
        // Verify that proof generated by onRamper is valid
        (uint256 offRamperVenmoId, uint256 amount, uint256 orderId, uint256 claimId, bytes32 nullifier) = _verifyAndParseOnRampProof(_a, _b, _c, _signals);

        // require it is an open order
        require(orders[orderId].status == OrderStatus.Open, "Order has already been filled, canceled, or doesn't exist");

        // Require that the claim exists
        require(orderClaims[orderId][claimId].status == ClaimStatus.Submitted,
            "Claim was never submitted, has been used, or has been clawed back"
        );

        // Require that the off-ramper was paid
        require(orderClaims[orderId][claimId].venmoId == offRamperVenmoId, 
            "Off-ramper paid does not match the claimer"
        );

        // Require that the amount paid by on-ramper >= minAskAmount of the off-ramper
        // Do not require amount to be less than maxAmount because if the on-ramper wants to pay more, they can
        // and we let the transaction go through.
        require(amount >= orderClaims[orderId][claimId].minAmountToPay, "Amount paid off-chain is too low");

        // Update order claim status
        orderClaims[orderId][offRamperVenmoId].status = ClaimStatus.Used;
        // Update order filled status
        orders[orderId].status = OrderStatus.Filled;
        // Update nullifier status
        nullified[nullifier] = true;

        usdc.transfer(orders[orderId].onRamper, orders[orderId].amountToReceive);
    }

    function cancelOrder(uint256 _orderId) external {
        require(orders[_orderId].status == OrderStatus.Open, "Order has already been filled, canceled, or doesn't exist");
        require(msg.sender == orders[_orderId].onRamper, "Only the order creator can cancel it");

        orders[_orderId].status = OrderStatus.Canceled;
    }

    function clawback(uint256 _orderId, uint256 _claimId) external {
        // Ensure the depositor address and clawback address are same
        require(
            orderClaims[_orderId][_claimId].offRamper == msg.sender,
            "Invalid caller"
        );
        // If a claim was never submitted (Unopened), was used to fill order (Used), or was already clawed back (Clawback) then
        // calling address cannot clawback funds
        require(
            orderClaims[_orderId][_claimId].status == ClaimStatus.Submitted,
            "Msg.sender has not submitted claim, already clawed back claim, or claim was used to fill order"
        );

        // If order is open then mm can only clawback funds if the claim has expired. For the case where order was cancelled all
        // we need to check is that the claim was not already clawed back (which is done above). Similarly, if the order was filled
        // we only need to check that the caller is not the claimer who's order was used to fill the order (also checked above).
        if (orders[_orderId].status == OrderStatus.Open) {
            require(orderClaims[_orderId][_claimId].claimExpirationTime < block.timestamp, "Order claim has not expired");
        }

        orderClaims[_orderId][_claimId].status = ClaimStatus.Clawback;
        usdc.transfer(msg.sender, orders[_orderId].amountToReceive);
    }

    /* ============ View Functions ============ */

    function getClaimsForOrder(uint256 _orderId) external view returns (OrderClaim[] memory) {
        uint256 claimNonce = orderClaimNonce[_orderId];

        OrderClaim[] memory orderClaimsArray = new OrderClaim[](claimNonce);
        for (uint256 i = 0; i < claimNonce; i++) {
            orderClaimsArray[i] = orderClaims[_orderId][i];
        }

        return orderClaimsArray;
    }

    function getAllOrders() external view returns (OrderWithId[] memory) {
        OrderWithId[] memory ordersArray = new OrderWithId[](orderNonce - 1);
        for (uint256 i = 1; i < orderNonce; i++) {
            ordersArray[i - 1] = OrderWithId({
                id: i,
                order: orders[i]
            });
        }

        return ordersArray;
    }

    /* ============ Internal Functions ============ */

    function _verifyAndParseOnRampProof(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        uint256[msgLen] memory signals
    )
        internal
        view
        returns (uint256 offRamperVenmoId, uint256 usdAmount, uint256 orderId, uint256 claimId, bytes32 nullifier)
    {   
        require(verifyProof(a, b, c, signals), "Invalid Proof"); // checks effects iteractions, this should come first

        // Signals [0] is offRamper Venmo ID
        offRamperVenmoId = signals[0];

        // Signals [1:3] are packed amount value
        uint256[3] memory amountSignals;
        for (uint256 i = 1; i < 4; i++) {
            amountSignals[i - 1] = signals[i];
        }
        uint256 amount = _stringToUint256(_convertPackedBytesToBytes(amountSignals, bytesInPackedBytes * 3));
        usdAmount = amount * 10 ** 6;

        // Signals [4, 5, 6] are nullifier
        bytes memory nullifierAsBytes = abi.encodePacked(
            signals[4], signals[5], signals[6]
        );
        nullifier = keccak256(nullifierAsBytes);
        require(!nullified[nullifier], "Email has already been used");

        // Signals [7, 8, ...., 23] are modulus.
        for (uint256 i = 7; i < msgLen - 2; i++) {
            require(signals[i] == venmoMailserverKeys[i - 7], "Invalid: RSA modulus not matched");
        }

        // Signals [24] is orderId
        orderId = signals[msgLen - 2];

        // Signals [25] is claimId
        claimId = signals[msgLen - 1];
    }

    // Unpacks uint256s into bytes and then extracts the non-zero characters
    // Only extracts contiguous non-zero characters and ensures theres only 1 such state
    // Note that unpackedLen may be more than packedBytes.length * 8 since there may be 0s
    // TODO: Remove console.logs and define this as a pure function instead of a view
    function _convertPackedBytesToBytes(uint256[3] memory packedBytes, uint256 maxBytes) public pure returns (string memory extractedString) {
        uint8 state = 0;
        // bytes: 0 0 0 0 y u s h _ g 0 0 0
        // state: 0 0 0 0 1 1 1 1 1 1 2 2 2
        bytes memory nonzeroBytesArray = new bytes(packedBytes.length * 7);
        uint256 nonzeroBytesArrayIndex = 0;
        for (uint16 i = 0; i < packedBytes.length; i++) {
            uint256 packedByte = packedBytes[i];
            uint8[] memory unpackedBytes = new uint8[](bytesInPackedBytes);
            for (uint j = 0; j < bytesInPackedBytes; j++) {
                unpackedBytes[j] = uint8(packedByte >> (j * 8));
            }

            for (uint256 j = 0; j < bytesInPackedBytes; j++) {
                uint256 unpackedByte = unpackedBytes[j]; //unpackedBytes[j];
                if (unpackedByte != 0) {
                    nonzeroBytesArray[nonzeroBytesArrayIndex] = bytes1(uint8(unpackedByte));
                    nonzeroBytesArrayIndex++;
                    if (state % 2 == 0) {
                        state += 1;
                    }
                } else {
                    if (state % 2 == 1) {
                        state += 1;
                    }
                }
                packedByte = packedByte >> 8;
            }
        }

        string memory returnValue = string(nonzeroBytesArray);
        require(state == 2, "Invalid final state of packed bytes in email");
        // console.log("Characters in username: ", nonzeroBytesArrayIndex);
        require(nonzeroBytesArrayIndex <= maxBytes, "Venmo id too long");
        return returnValue;
        // Have to end at the end of the email -- state cannot be 1 since there should be an email footer
    }

    // Code example:
    function _stringToUint256(string memory s) internal pure returns (uint256) {
        bytes memory b = bytes(s);
        uint256 result = 0;
        uint256 oldResult = 0;

        for (uint i = 0; i < b.length; i++) { // c = b[i] was not needed
            // UNSAFE: Check that the character is a number - we include padding 0s in Venmo ids
            if (uint8(b[i]) >= 48 && uint8(b[i]) <= 57) {
                // store old value so we can check for overflows
                oldResult = result;
                result = result * 10 + (uint8(b[i]) - 48);
                // prevent overflows
                require(result >= oldResult, "Overflow detected");
            }
        }
        return result; 
    }
}
