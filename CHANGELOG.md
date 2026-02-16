# SOLUS Changelog

All notable changes to SOLUS are documented in this file.

---

## [2.0.0] - February 2026

### Major New Features

#### Discord Mode & Integration
- **Dedicated Discord Page** — Discord import now has its own navigation page (no longer buried in Settings)
- **Profile Stats** — Account Stats becomes "Profile Stats" in Discord mode, grouping orders by bot profile name
- **Discord Bot Linking** — Connect SOLUS to your Discord account with secure token authentication
- **Channel Watching** — Monitor specific Discord channels for order confirmations
- **Auto-Sync Discord Orders** — Configurable sync intervals (5/15/30/60 minutes)
- **Discord Webhooks** — Send reports and notifications to Discord channels with rich embeds

#### Data Mode System
- **Exclusive Mode Toggle** — Switch between IMAP (email) and Discord modes in Settings
- **Mode-Aware UI** — Interface adapts based on selected mode:
  - Discord mode: Hides Deliveries, Shipped/Delivered stats, Carriers tab (data not available from Discord)
  - IMAP mode: Hides Discord nav, shows full delivery tracking features

#### Analytics Engine
- **Carrier Performance Tab** — New analytics section for shipping carrier statistics
- **Enhanced Charts** — Order volume, spending trends, retailer breakdown visualizations
- **Stick Rate Calculations** — Track confirmation-to-cancellation ratios by account/profile

#### Account Intelligence
- **Performance Tiers** — Accounts rated as Gold/Silver/Bronze based on success metrics
- **Account Scoring** — Reliability ratings (Perfect/Good/Okay/At-Risk)
- **Account Stats Page** — Comprehensive per-account/per-profile analytics

#### Reports System
- **Quick Report Generator** — Generate reports with customizable sections
- **Report Templates** — Save and reuse report configurations
- **Discord Report Sharing** — Send reports directly to Discord webhooks
- **PDF Export** — Export orders and reports as formatted PDFs

#### Inventory & TCG Tracking
- **Inventory Management** — Track items from delivered orders
- **TCGPlayer Integration** — Link items to TCGPlayer for price tracking
- **Portfolio Value** — Track total inventory value with price change indicators
- **Price History** — Monitor low/high/current prices over time

### UI/UX Improvements

#### Theme & Customization
- **Accent Color System** — 6 preset colors (Purple, Blue, Green, Red, Orange, Pink) + custom color picker
- **Light/Dark Mode** — Full theme toggle with consistent styling
- **Custom CSS Variables** — Theme colors flow through entire application

#### Dashboard Enhancements
- **Empty States** — Helpful guidance when no data exists
- **Customizable Layout** — Configure which stats to display
- **Retailer Quick Access** — Click retailer cards to view orders

#### Order Management
- **Bulk Actions** — Select multiple orders for bulk deliver/delete
- **Flex Modal Improvements** — Better multi-item order display
- **Profile Info Display** — Discord orders show profile name and bot type
- **Drop Grouping** — Orders grouped by confirmation date (not delivery date)

#### Navigation
- **Streamlined Sidebar** — Reorganized nav with mode-aware visibility
- **Page Guards** — Prevents accessing irrelevant pages for current mode

### Backend Improvements

#### Security
- **Edge Function Migration** — Removed Supabase service_role key from shipped app
- **Server-Side Operations** — Discord API calls now go through secure Edge Functions
- **Anon Key Only** — Client only has access to anonymous API key

#### Email Parsing
- **Target Parser Fix** — Handles new email format with multiline "Order total" and amount
- **Improved Amount Extraction** — Better regex patterns for various email formats
- **Confirmed Date Tracking** — Orders track original confirmation date through status updates

#### Sync & Performance
- **Auto-Resume** — Configurable auto-resume for failed syncs
- **Proxy Support** — Test and manage proxy connections for IMAP
- **Connection Resilience** — Better handling of IMAP disconnections

### Bug Fixes
- Fixed drop cards showing wrong items when orders had multiple status emails
- Fixed delivered orders being grouped by delivery date instead of original order date
- Fixed amount not merging correctly when $0 appeared before actual amount
- Fixed Target orders showing $0 (parser now handles new email format)
- Fixed analytics charts overflowing container bounds
- Fixed various UI alignment and spacing issues

### Technical Changes
- Supabase Edge Function: `discord-aco-api` handles all Discord-related API calls
- IPC handlers updated: `discord-check-link`, `discord-generate-token`, `discord-sync-orders`, `discord-get-link-status`, `discord-unlink`
- Added `confirmedDate` field to order status computation
- Added `profileName` and `acoBotType` fields to Discord orders

---

## [1.x.x] - Previous Releases

### Core Features (Established)
- Multi-retailer email parsing (Walmart, Target, Pokemon Center, Sam's Club, Costco, Best Buy)
- IMAP email synchronization with Gmail, Outlook, Yahoo support
- Order tracking with status updates (Confirmed → Shipped → Delivered → Cancelled)
- Carrier tracking integration (FedEx, UPS, USPS, DHL, OnTrac)
- Address jig detection and normalization
- License key validation system
- Local data storage with JSON persistence
- Auto-update system via GitHub releases
