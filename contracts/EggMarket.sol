// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EggNFT} from "./EggNFT.sol";

/// @title EggMarket — animal secondary market (ported from BNBCAT v5 Market).
/// @notice Sellers list HATCHED ANIMALS (species 1..5) at a BNB asking
/// price. Unhatched eggs and empty shells (species 6) can NOT be
/// listed (user decision 2026-11-03: only hatched animals trade on
/// the market) — they can still move wallet-to-wallet by plain NFT
/// transfer. A listed NFT stays in the seller's wallet and keeps
/// producing; on sale the NFT moves to the buyer and ALL of its state
/// rides with it — unclaimed MAO, patience-bonus progress, claim-pause
/// remainder, age clock — because that state lives on the NFT itself.
/// No seller-side settlement ever happens at sale time (SPEC section 9).
/// The market takes MARKET_FEE_BPS (2.5%) to the project wallet; the
/// seller receives the rest. An egg locked in a pending hatch can
/// neither be listed nor bought. Every buy revalidates ownership AND
/// the market's approval at execution time, so stale listings can never
/// execute; revoking the market's approval on the NFT contract wipes
/// all of that seller's listings at once.
contract EggMarket is ReentrancyGuard {
    uint256 public constant MARKET_FEE_BPS = 250; // 2.5% (SPEC section 10: proposed, pending final confirmation)
    address public immutable eggsAddr;
    address public immutable projectWallet;

    struct Listing {
        address seller;
        uint256 price;
    }

    mapping(uint256 => Listing) public listings;
    mapping(address => uint256[]) internal _sellerListings;
    mapping(uint256 => uint256) internal _listingIndex; // tokenId => index + 1 in seller array

    event Listed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event ListingCancelled(uint256 indexed tokenId, address indexed seller);
    event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 fee);

    constructor(address eggs_, address projectWallet_) {
        eggsAddr = eggs_;
        projectWallet = projectWallet_;
    }

    function _eggs() internal view returns (EggNFT) {
        return EggNFT(eggsAddr);
    }

    function _isApproved(uint256 tokenId, address seller) internal view returns (bool) {
        EggNFT e = _eggs();
        return e.getApproved(tokenId) == address(this) || e.isApprovedForAll(seller, address(this));
    }

    function listingOf(uint256 tokenId) external view returns (address seller, uint256 price) {
        Listing storage l = listings[tokenId];
        return (l.seller, l.price);
    }

    function listingsOf(address seller) external view returns (uint256[] memory) {
        return _sellerListings[seller];
    }

    function list(uint256 tokenId, uint256 price) external {
        EggNFT e = _eggs();
        require(price > 0, "price zero");
        require(e.ownerOf(tokenId) == msg.sender, "not your egg");
        require(listings[tokenId].seller == address(0), "already listed");
        require(!e.hatchPending(tokenId), "egg hatching");
        require(!e.claimPending(tokenId), "claim pending");
        // Only hatched animals (species 1..5) are listable: unhatched
        // eggs and empty shells revert here (user decision 2026-11-03).
        uint8 species = e.speciesOf(tokenId);
        require(species >= 1 && species <= 5, "not an animal");
        require(_isApproved(tokenId, msg.sender), "market not approved");
        listings[tokenId] = Listing({seller: msg.sender, price: price});
        _sellerListings[msg.sender].push(tokenId);
        _listingIndex[tokenId] = _sellerListings[msg.sender].length;
        emit Listed(tokenId, msg.sender, price);
    }

    function cancel(uint256 tokenId) external {
        require(listings[tokenId].seller == msg.sender, "not your listing");
        _remove(tokenId);
        emit ListingCancelled(tokenId, msg.sender);
    }

    /// @notice Remove a listing that can no longer execute (NFT gone,
    /// transferred, approval revoked, or locked in a hatch). Anyone may
    /// clean up.
    function cleanListing(uint256 tokenId) external {
        Listing storage l = listings[tokenId];
        require(l.seller != address(0), "no listing");
        bool stale;
        try _eggs().ownerOf(tokenId) returns (address o) {
            stale = o != l.seller || !_isApproved(tokenId, l.seller) || _eggs().hatchPending(tokenId)
                || _eggs().claimPending(tokenId);
        } catch {
            stale = true; // burned / nonexistent
        }
        require(stale, "listing still valid");
        address seller = l.seller;
        _remove(tokenId);
        emit ListingCancelled(tokenId, seller);
    }

    /// @notice Called by the NFT contract when its approval is revoked.
    /// Only the seller themself or the NFT contract may clear a seller's
    /// listings (ported BNBCAT v5 F3).
    function clearListingsOf(address seller) external {
        require(msg.sender == seller || msg.sender == eggsAddr, "not authorized");
        uint256[] storage arr = _sellerListings[seller];
        while (arr.length > 0) {
            uint256 tokenId = arr[arr.length - 1];
            delete _listingIndex[tokenId];
            delete listings[tokenId];
            arr.pop();
            emit ListingCancelled(tokenId, seller);
        }
    }

    function buy(uint256 tokenId) external payable nonReentrant {
        Listing storage l = listings[tokenId];
        address seller = l.seller;
        uint256 price = l.price;
        require(seller != address(0), "no listing");
        require(msg.sender != seller, "own listing");
        require(msg.value >= price, "underpaid");
        EggNFT e = _eggs();
        require(e.ownerOf(tokenId) == seller, "stale listing");
        require(_isApproved(tokenId, seller), "approval revoked");
        require(!e.hatchPending(tokenId), "egg hatching");
        require(!e.claimPending(tokenId), "claim pending");

        _remove(tokenId);
        uint256 fee = (price * MARKET_FEE_BPS) / 10_000;
        uint256 sellerGets = price - fee;
        e.safeTransferFrom(seller, msg.sender, tokenId);
        (bool okF,) = projectWallet.call{value: fee}("");
        require(okF, "fee transfer failed");
        (bool okS,) = seller.call{value: sellerGets}("");
        require(okS, "seller transfer failed");
        uint256 refund = msg.value - price;
        if (refund > 0) {
            (bool okR,) = msg.sender.call{value: refund}("");
            require(okR, "refund failed");
        }
        emit Sold(tokenId, seller, msg.sender, price, fee);
    }

    function _remove(uint256 tokenId) internal {
        Listing storage l = listings[tokenId];
        address seller = l.seller;
        uint256 idx = _listingIndex[tokenId];
        if (idx > 0) {
            uint256[] storage arr = _sellerListings[seller];
            uint256 i = idx - 1;
            uint256 last = arr[arr.length - 1];
            arr[i] = last;
            _listingIndex[last] = i + 1;
            arr.pop();
            delete _listingIndex[tokenId];
        }
        delete listings[tokenId];
    }

    receive() external payable {}
}
