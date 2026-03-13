# SOLUS User Guide

**Version 4.0 | Order Analytics for Resellers**

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Data Modes](#2-data-modes)
3. [Dashboard](#3-dashboard)
4. [IMAP Accounts and Email Sync](#4-imap-accounts-and-email-sync)
5. [Discord ACO Integration](#5-discord-aco-integration)
6. [Retailer Pages](#6-retailer-pages)
7. [Flex Cards](#7-flex-cards)
8. [Delivery Hub](#8-delivery-hub)
9. [Live Track](#9-live-track)
10. [Analytics](#10-analytics)
11. [Account Stats](#11-account-stats)
12. [Reports](#12-reports)
13. [Inventory and Portfolio](#13-inventory-and-portfolio)
14. [TCG Price Tracker](#14-tcg-price-tracker)
15. [Settings Reference](#15-settings-reference)
16. [Keyboard Shortcuts](#16-keyboard-shortcuts)
17. [Best Practices](#17-best-practices)
18. [Troubleshooting](#18-troubleshooting)
19. [Glossary](#19-glossary)

---

## 1. Getting Started

### Activation

When you first launch SOLUS, you will be prompted to enter your license key. Enter your key and click **Activate License**. Once activated, you have full access to all features.

SOLUS validates your license online. If the internet is temporarily unavailable, a 30-minute offline grace period keeps the app functional.

### License Plans

| Plan | Duration | Renewal |
|------|----------|---------|
| Monthly | 30 days | Auto-renews or expires |
| Yearly | 365 days | Auto-renews or expires |
| Lifetime | Unlimited | Never expires |

View your license details at any time in **Settings > License**. The display shows your masked key, plan type, status, activation date, expiration date, and days remaining. Days remaining is color-coded: green when more than 30 days remain, orange under 30, yellow under 7, and red when expired.

Click **Disconnect License** to deactivate your license on the current device.

### Onboarding Walkthrough

After activation, a five-step guided walkthrough appears automatically:

1. **Welcome** — Overview of what SOLUS does
2. **Accounts** — How to connect your email accounts
3. **Sync** — How to pull in order data
4. **Dashboard** — Navigating the main interface
5. **Analytics** — Understanding your charts and metrics

You can skip the walkthrough at any time. To replay it later, go to **Settings > General > Show Walkthrough**.

### First Steps

1. Choose your data mode: IMAP (email sync) or Discord (ACO bot sync)
2. Connect your data source: add email accounts or link your Discord
3. Run your first sync to pull in order data
4. Explore your data across the dashboard, retailer pages, and analytics

### Supported Platforms

SOLUS runs on Windows (x64) and macOS (Apple Silicon and Intel). When a new version is available, a notification appears in the app with options to download and install.

On macOS, updates are downloaded as a DMG to your Downloads folder. On Windows, the installer runs automatically after download.

---

## 2. Data Modes

SOLUS supports two methods of importing order data. Choose your mode in **Settings > General**.

### IMAP Mode (Email Sync)

Connects directly to your email accounts via IMAP and parses order confirmations, shipping updates, and delivery notifications. This mode tracks the full order lifecycle from confirmed through shipped to delivered. It enables the Delivery Hub, Live Track, carrier analytics, and address-based grouping.

Best for: complete order tracking with delivery and carrier data.

### Discord Mode (ACO Bot Sync)

Syncs orders captured by Discord auto-checkout bots through the SOLUS Discord relay server. This mode tracks confirmed, cancelled, and declined statuses. It enables the ACO Panel with profile mappings, webhook forwarding, and per-profile analytics.

Best for: monitoring ACO bot checkouts across multiple profiles.

### Switching Modes

1. Go to **Settings > General**
2. Click **IMAP Mode** or **Discord Mode**
3. Confirm the switch

Your orders from the other mode are preserved separately. The sidebar navigation updates to show only the pages relevant to your active mode.

---

## 3. Dashboard

The Dashboard is your home screen, providing a quick overview of all orders across every retailer.

### Retailer Cards

Each supported retailer has a summary card displaying:

- **Confirmed** — Orders successfully placed
- **Cancelled** — Orders that were cancelled
- **Shipped** — Orders currently in transit (IMAP mode)
- **Delivered** — Orders that have arrived (IMAP mode)

In Discord mode, the "Shipped" column displays **Declined** instead, reflecting payment-declined checkout attempts.

Click any retailer card to jump directly to that retailer's detailed page.

### Customizable Layout

Click the **Customize** gear icon in the top-right corner to personalize your dashboard.

**Retailer toggles:** Show or hide cards for Walmart, Target, Pokemon Center, Sam's Club, Costco, and Best Buy based on which retailers you actively use.

**Section toggles:** Show or hide the Overall Statistics bar and the Quick Stats bar.

Your layout preferences save automatically and persist across sessions. Hiding a retailer card does not delete any underlying data.

### Dashboard Alerts

An alerts bar appears at the top when items need your attention:

- **Low Stick Rate Warning** — Accounts below 50% stick rate. Click to jump to Account Stats.
- **Overdue Deliveries** — Orders awaiting delivery past their ETA. Click to jump to Delivery Hub.
- **Recent Cancellations** — Orders cancelled in the last 24 hours. Click to view details.

Alerts can be dismissed per session. They reappear on your next launch if conditions still apply.

### Quick Stats Bar

A persistent bar below the alerts showing at-a-glance numbers:

- **In Transit** — Packages currently on the way
- **Arriving Today** — Deliveries expected today
- **Spending This Month** — Total confirmed order value for the current month
- **Delivered This Week** — Packages that arrived in the last 7 days

Each stat is clickable and navigates to the relevant page.

### Statistics Bar

View aggregated totals across all retailers: total orders, total spent, overall stick rate, and confirmed/cancelled/shipped/delivered counts.

### Time Period Filter

Toggle between **7D**, **30D**, **90D**, or **All** to scope the dashboard data to a specific window.

---

## 4. IMAP Accounts and Email Sync

Connect your email accounts to automatically sync order confirmations, shipping updates, and delivery notifications from six supported retailers.

### Supported Retailers

| Retailer | Order ID Format |
|----------|----------------|
| Walmart | 7-digit |
| Target | 15-digit |
| Pokemon Center | Variable |
| Sam's Club | 8-digit |
| Costco | 10-digit |
| Best Buy | BBY01-XXXXXX |

### Supported Email Providers

| Provider | Domains | App Password |
|----------|---------|-------------|
| Gmail | @gmail.com | Required |
| Yahoo | @yahoo.com | Required (2FA must be enabled) |
| Outlook | @outlook.com, @hotmail.com, @live.com | Required if 2FA is enabled |
| iCloud | @icloud.com, @me.com, @mac.com | Required |

The provider is auto-detected from your email address.

### Adding an Account

1. Click **+ Add Account**
2. Select your email provider (or let it auto-detect)
3. Enter your email address
4. Enter your **App Password** (not your regular login password)
5. Click **Test Connection** to verify credentials
6. Click **Add Account**

> **Important:** Always use an app-specific password, never your regular email password. This is both a security best practice and a requirement for most providers with two-factor authentication enabled.

### App Password Setup by Provider

**Gmail:** Go to your Google Account > Security > 2-Step Verification > App Passwords. Generate a 16-character password and use it in SOLUS. IMAP must also be enabled in Gmail Settings > Forwarding and POP/IMAP.

**Outlook / Hotmail:** If you have 2FA enabled, generate an app password in your Microsoft account security settings. If 2FA is off, your regular password may work.

**Yahoo:** Go to Account Security in your Yahoo account settings. Generate an app password for "Other App" and use the generated password in SOLUS.

**iCloud:** Go to appleid.apple.com, sign in, and generate an app-specific password under Security. iCloud also supports Hide My Email addresses, which SOLUS automatically detects and groups.

### Account Management

Each account in the list shows its email with a provider badge, an editable nickname, last sync time, order count, and action buttons for Test Connection, View Sync Log, Sync, Edit Password, and Delete.

Click the nickname to rename an account (up to 30 characters) for easier identification when managing multiple accounts.

### Syncing

Once an account is added, you have three sync options:

| Action | Description |
|--------|-------------|
| **Sync Recent** | Syncs from the last sync date, or the last 7 days for a first sync |
| **Sync All** | Full historical sync with a custom date range |
| **Rescue from Spam** | Finds order emails in spam and moves them to the inbox |

During sync, a progress bar shows the current percentage and a status message describing what SOLUS is doing. You can **Pause** (saves progress for later resumption) or **Stop** (abandons the current sync).

### How Sync Works

SOLUS connects to your mailbox via IMAP and searches for order-related emails using 27 optimized search patterns across senders and subjects. Emails are fetched in batches (100 at a time for Gmail and Outlook, 50 for iCloud) with built-in retry logic and stall detection.

Each email is parsed to extract the order ID, item name, quantity, amount, status, tracking number, carrier, shipping address, and product images. Orders from multiple emails (confirmation, shipping update, delivery notification) are automatically merged into a single entry using the order ID as the key.

Only orders that have a matching confirmation email are saved. This prevents promotional emails and spam from creating false orders.

### Paused Syncs and Auto-Resume

If a sync pauses due to connection issues, you will see a yellow highlight on the account with a "Paused (X remaining)" indicator. You can resume manually at any time.

If auto-resume is enabled (Settings > General), SOLUS automatically retries the paused sync after your configured interval. Auto-resume retries up to 3 times before stopping permanently.

### Auto-Sync on Launch

When enabled in Settings, SOLUS automatically syncs all accounts on startup, pulling orders from each account's last sync date (or 7 days back if never synced).

### Deep Scan Mode

Enable Deep Scan in Settings > General to search all emails in the date range rather than using targeted search patterns. This catches emails that might use unusual formatting but takes significantly longer.

### Bulk Import

Click **Import CSV** to bulk import multiple email accounts from a CSV file. The CSV should contain email addresses and app passwords.

### Sync Log

Click **View Sync Log** on any account to see detailed IMAP diagnostics including connection events, email counts, parsing results, and any errors.

---

## 5. Discord ACO Integration

SOLUS integrates with Discord auto-checkout bots to track orders captured in your Discord server channels.

### Supported ACO Bots

Alpine, Valor, Hayha, Stellara, Refract, Shikari, TSB, and any generic bot format that the SOLUS Discord bot can detect.

### Linking Your Discord Account

1. Go to the **Discord** page in the sidebar
2. Click **Generate Link Token** to create a 6-character code (valid for 5 minutes)
3. In your Discord server, run `/link <token>` with the SOLUS bot
4. Once linked, your Discord username appears and your watched channels load

### Order Statuses in Discord Mode

| Status | Meaning |
|--------|---------|
| Confirmed | Order successfully placed by the bot |
| Cancelled | Order cancelled (retailer-initiated or manual) |
| Declined | Payment failed or was rejected (does not penalize stick rate) |

Declined orders are distinguished from true cancellations. A declined order represents a failed payment attempt, not a placed-and-then-cancelled order. This distinction keeps your stick rate and analytics accurate.

### ACO Panel

The ACO Panel is your hub for managing Discord checkout data. It has two tabs: **Users** and **Settings**.

#### Users Tab

The Users tab shows all Discord profiles grouped by user.

**Profile Cards:** Each card shows the Discord username, profile count, total order count, and per-site breakdown. Click a card to expand into a detail view with per-site stats, recent orders, and action buttons.

**Profile Mapping:** Click **+ Link Profile** to associate a profile name with a Discord user:

1. Enter the profile name (must match exactly what the ACO bot uses)
2. Enter the Discord User ID (17-20 digit number)
3. Optionally enter the Discord username
4. Click Save

Profile mappings are stored server-side and enable @mention tagging when orders are forwarded via webhook.

**Searching and Filtering:** Search by Discord username, user ID, or profile name. Filter by All, Mapped only, or Unmapped only. Filter by site and by performance tier.

**Export:** Click **Export** to download ACO profile data as CSV. Filter by user type, performance tier, site, stick rate range, and order count range. Choose between Summary and Detailed export levels.

#### Settings Tab

The Settings tab has six sections:

**Saved Webhooks:** Manage your Discord webhook URLs. Add up to 10 webhooks, each with a name and URL. Test, edit, or delete any webhook. URLs must be valid Discord webhook URLs.

**Watched Channels:** Assign a saved webhook to each channel the SOLUS bot is monitoring. A "Bot forwarding" indicator appears when server-side forwarding is active for that channel, meaning orders forward even when SOLUS is closed.

**Auto-Forward:** Toggle automatic forwarding of new orders to assigned webhooks when SOLUS syncs. A sub-toggle controls whether declined and cancelled orders are included.

**Sync Settings:** Shows last sync time and count. Buttons for Sync Now, Refresh Images (re-maps product images), and Clear Orders (deletes all Discord-source orders).

**Diagnostics:** Shows webhook count and Discord link status for quick troubleshooting.

**Recent Forward Log:** An audit trail of forwarded orders (up to 200 stored, 50 shown). Each entry shows status, item name, profile, and timestamp. An "@mentioned" badge appears when a Discord mention was included.

### Server-Side Bot Forwarding

When you assign a webhook to a channel, SOLUS syncs the URL to the server. The Discord bot then forwards orders automatically and instantly, even when SOLUS is closed. Forwarded embeds include the order status, retailer, item name, profile, product image, and SOLUS branding. If a profile mapping exists, the embed tags the Discord user. The bot refreshes its channel cache every 60 seconds.

### Auto-Sync in Discord Mode

When auto-sync is enabled, SOLUS checks for new orders at your configured interval (default: 15 minutes). New orders are automatically forwarded if the auto-forward toggle is on. A toast notification shows the count of new orders and forwards.

---

## 6. Retailer Pages

Each supported retailer has a dedicated page with detailed order information, accessible from the sidebar or by clicking a dashboard card.

### Supported Retailers

- **Walmart** — Blue theme
- **Target** — Red theme
- **Pokemon Center** — Yellow/Amber theme
- **Sam's Club** — Navy theme
- **Costco** — Red theme
- **Best Buy** — Blue theme

### Statistics Grid

At the top of each retailer page, a statistics grid displays confirmed, cancelled, shipped, delivered, total orders, and total spent for that retailer.

### Drops View

Orders are grouped by "drops" (order date). Each drop card shows:

- Up to 3 product images
- Item name previews (up to 4 items)
- Account count
- Status breakdown (confirmed, cancelled, shipped, delivered)
- Stick rate percentage
- Total spent for that drop
- **Resync** button to re-fetch emails for that date
- **Flex** button to create a shareable visual card

Click a drop to expand into its detail view, showing orders grouped by SKU with full order information.

### Items Grid

Below the drops, an items grid shows each unique product with its image, name, quantity ordered, stick rate, and total spend. Click an item to filter the orders list to that product and see a detailed item modal.

### Item Detail Modal

Clicking an item opens a modal showing the product image, item name, quantity and order count, per-status breakdown, and a list of all orders for that item with status badges, dates, amounts, and account information.

### Orders List

The full order list supports multiple view and filter options.

**Search:** Filter by item name, order ID, amount, tracking number, or date. Press **/** to jump directly to the search bar.

**Advanced Filters:** Expand the filter panel to access date range, amount range, carrier, status checkboxes, tracking availability toggle, and account/email filter. A badge shows the active filter count. Click **Clear All Filters** to reset.

**View Modes:** Toggle between Grid and List view. In List view, toggle visible columns: item name, email/account, ETA, shipping address, tracking number, and per-unit price.

**Period Filter:** Filter by All, 30 days, 60 days, or 90 days.

**Sorting:** Sort by date, order ID, amount, status, or item name. Click a column header to toggle ascending/descending.

Filters persist per retailer while the app is open.

### Bulk Operations

Hold **Ctrl/Cmd** and click to select multiple drops, or use the **Select All** checkbox. A floating action bar appears showing the selection count with options to **Mark Delivered** or **Export CSV**.

### Target-Specific Features

Target pages include additional image management tools:

- **Fetch Images** — Scrapes Target.com for product images on drops that are missing them
- **Auto-Spread Images** — Fills missing images from other drops with the same product
- **Clear Images** — Removes fetched images (hover a drop to reveal)

---

## 7. Flex Cards

Flex cards are styled visual summaries of a drop that you can save as an image or share to Discord.

### Creating a Flex Card

1. Navigate to any retailer page
2. Click the **Flex** button on a drop card
3. A modal appears with product images, order stats (confirmed, quantity, spent, stick rate), and item breakdown

### Visual Features

The flex card includes a tiled SOLUS prism watermark background, a branded "SOLUS" label in the bottom-right corner, and the retailer name with drop date in the bottom-left corner.

For multi-item orders, a cart breakdown section shows each item with its thumbnail, name, order count, and spend. Quantity badges appear on product images only for multi-item orders; single-item drops display a clean image without badges.

### Saving

Click **Save PNG** to save the card as an image file. The image is also automatically copied to your clipboard. If you have set a flex save folder in **Settings > General**, the file saves directly to that folder. Otherwise, a standard download dialog appears.

File names follow the format `solus-{retailer}-{month}-{day}.png`.

### Sharing to Discord

Click the **Discord** button to send the flex card to your configured webhook. Two messages are sent:

1. A styled embed with the retailer name, drop date, item list, confirmed count, quantity, spend, and stick rate
2. The flex card image as an embedded attachment

Configure your webhook in **Settings > Reports** before using this feature.

---

## 8. Delivery Hub

Track all incoming packages in one place. Available in IMAP mode.

The Delivery Hub has four tabs: In Transit, Recently Delivered, Calendar, and Live Track.

### In Transit

Shows all packages currently on the way.

**Summary Cards:**
- **Today** — Packages arriving today
- **This Week** — Arriving within 7 days
- **In Transit** — All shipped orders
- **Alerts** — Delivery issues (stale shipments, delayed orders)

Click any card to filter to that category.

**View Modes:**
- **Timeline** — Organized by delivery date: Today, Tomorrow, This Week, Later, No ETA
- **By Address** — Grouped by shipping address
- **By Retailer** — Grouped by store

**Delivery Cards:** Each card shows the retailer badge, product image, item name, shipping address, carrier, tracking number, and ETA. The ETA is color-coded for arrivals today, tomorrow, or overdue. Expand a card for full order details. Action buttons include **Track** (opens carrier tracking in your browser) and **Mark Delivered**.

**Bulk Actions:** Use checkboxes or Select All to choose multiple items. A floating action bar lets you mark all selected as delivered.

### Recently Delivered

View orders that have already arrived. Filter by Last 7 Days, 30 Days, 90 Days, Year, or All Time.

### Calendar

A visual calendar showing deliveries by date. Navigate months with arrows or jump to today. Each date cell shows up to 3 orders with item names and a "+N more" indicator for busy days. Click any day to see a popup with full delivery details for that date.

### Address Linking

In the By Address view, you can drag and drop addresses to link them together. This is useful for grouping jig address variants. View and manage linked addresses in **Settings > Jig Detection**.

---

## 9. Live Track

Real-time package tracking powered by the FedEx API. Located in the Delivery Hub's Live Track tab.

### How to Use

1. Set your **date range** (defaults to the last 30 days)
2. Click **Search** to fetch live tracking data for all FedEx shipments in that range
3. Results display with real-time statuses, updated ETAs, and status descriptions

Live Track uses a manual search approach to conserve API credits. Data is only fetched when you click Search.

### Filters and Sorting

**Status Filters:** All, In Transit, Out for Delivery, Delivered, Exception, Pending, No Data

**Sort Options:** ETA (soonest or latest first), Status, Retailer, Date (oldest or newest first)

### Status Updates

When Live Track returns updated information, SOLUS can apply those updates to your orders. Delivered packages are marked as delivered, and updated ETAs are applied to in-transit orders.

### Cache

Results are cached locally for faster repeat access. Click **Clear Cache** to reset if results seem stale.

---

## 10. Analytics

Deep dive into your ordering performance with comprehensive charts and insights.

### Summary Cards

At the top of the Analytics page, summary cards show total orders, confirmed count, total spent, and overall stick rate for the selected period.

### Filters

**Retailer Tabs:** View data for All retailers or filter to any individual retailer.

**Period Filter:** 7 Days, 30 Days, 90 Days, 1 Year, or All Time.

**Period Comparison:** Click the **Compare** toggle to overlay the previous period's data as a dashed line on spending, stick rate, and cancel rate charts. For example, viewing 30 Days with Compare enabled overlays the prior 30-day period for trend analysis.

### Sub-Tabs

Analytics is organized into four sub-tabs.

#### Overview

The main summary with spending over time and stick rate trend charts.

#### Trends

**Cancel Rate Trend** — Line chart in red showing daily cancellation rate, helping you identify spike patterns.

**Order Volume** — Stacked bar chart with green bars for confirmed and red for cancelled, showing both volume and success rate at a glance.

**Retailer Comparison** — Horizontal bar chart (visible when "All" retailers is selected). Toggle between three metrics: stick rate, total orders, and total spending.

#### Patterns

**Ordering Patterns Heatmap** — Shows order distribution by day of the week, with per-retailer tabs and color intensity based on volume. Includes peak day insights such as "Your busiest day at Walmart is Tuesday."

**Carrier Performance** — Three visualizations: a doughnut chart showing carrier distribution, a bar chart showing average delivery time per carrier, and a stats table with total shipments, average transit time, and on-time percentage.

#### Insights

A dedicated panel showing your top and bottom performers:

- **Top Items by Stick Rate** — Products with the highest confirmation rate (minimum 3 orders)
- **Top Items by Spend** — Where you are spending the most
- **Top Items by Volume** — Most-ordered products
- **Worst Performers** — Items with the highest cancellation rates
- **Biggest Drop Days** — Dates with the most orders

Clickable item names navigate directly to the retailer page with that item searched.

### Chart Toggle Bar

Use the toggle bar to show or hide individual chart sections for a cleaner view.

---

## 11. Account Stats

Analyze performance by individual email account (IMAP mode) or Discord profile (Discord mode). The page title changes based on your active mode: **Account Stats** or **Profile Stats**.

### Filters

- **Retailer** — All or any individual retailer
- **Time Period** — 7D, 30D, 90D, All, or Custom date range
- **Search** — Search by email, address, or profile name
- **Tier Chips** — Filter to specific performance tiers
- **View Toggle** — Grid (cards) or List (rows)

### Sort Options

Sort by stick rate, risk score, order count, total spent, or account name. Group by ship address for Pokemon Center.

### Metrics Per Account

Each account card displays:

- **Rank** — Top 3 accounts get gold, silver, and bronze badges
- **Email or Profile Name** — With editable nickname
- **Stick Rate** — With tier color and trend arrow (improving, flat, or declining)
- **Tier Label** — Diamond, Perfect, Good, Okay, or At Risk
- **Benchmark** — Comparison vs tier average
- **Risk Score** — 0 to 100, color-coded
- **Mini Outcome Bar** — Visual confirmed/total ratio
- **Detailed Metrics** — Confirmed/total orders, total spent, average order value, last order date
- Expandable mini order list

In Discord mode, cards also show bot type, decline count, decline rate, and health score. For Pokemon Center, cards include base address grouping, variant count, and expandable variant details.

### Tier System

| Tier | Stick Rate | Color | Requirements |
|------|-----------|-------|--------------|
| Diamond | 100% | Ice-blue glow | 3+ orders and 100% stick rate |
| Perfect | 80%+ | Purple | — |
| Good | 60%+ | Jade green | — |
| Okay | 40%+ | Orange | — |
| At Risk | Below 40% | Red | — |

### Risk Score

Each account receives a composite score from 0 to 100 based on four factors:

| Factor | Weight | Description |
|--------|--------|-------------|
| Stick Rate | 40% | Higher stick rate increases score |
| Order Volume | 25% | More orders means more reliable data (log scale, 20 orders = full credit) |
| Recent Trend | 20% | Improving stick rate boosts score |
| Decline Rate | 15% | High decline rate penalizes score |

**Score colors:** Green (80-100) is healthy, Yellow (60-79) is acceptable, Orange (40-59) is at risk, and Red (0-39) is high risk.

### Recommendations

Accounts with 5 or more orders receive actionable recommendations:

- **Performing** (green) — Stick rate 80%+, decline rate below 10%
- **Needs Attention** (yellow) — Stick rate 70-80%, decline rate 10-20%, or inactive 14+ days
- **Consider Retiring** (red) — Stick rate below 50% or decline rate above 20%

Accounts with fewer than 5 orders show "Need more data."

### Summary Cards

At the top of the page: total account/profile count, base addresses (Pokemon Center), average stick rate with period-over-period delta, total spent or total declines, Diamond/Perfect counts, and accounts needing attention.

### Tier Distribution Bar

A visual bar showing the count of accounts in each tier for a quick picture of overall account health.

### Advanced Filter Modal

Click the filter icon to access minimum stick rate, minimum orders, date range, and tier selection. A badge shows the active filter count.

### Export

Click **Export** to download account stats as CSV. Filter by user type, performance tier, site, stick rate range, and order count range. Choose Summary or Detailed export level.

---

## 12. Reports

Generate, export, and share detailed reports from your order data.

### Configuring a Report

Select your parameters before generating:

- **Time Period** — 7D, 30D, 90D, All Time, or Custom date range
- **Retailer** — All retailers or a specific one
- **Sections** — Toggle: Summary, Retailers, Top Items, Accounts, Carriers

### Report Sections

| Section | Contents |
|---------|----------|
| Summary Stats | Total orders, confirmed, cancelled, stick rate, total spent |
| Retailer Breakdown | Per-retailer order counts and spend |
| Top Performers | Best items by stick rate, spend, and volume |
| Account Scores | Risk scores and stick rates per account |
| Carrier Stats | Carrier distribution and average delivery times |

### Generating and Previewing

Click **Generate Report** to compile the data. A styled preview appears in-app matching SOLUS branding, with a timestamp showing when the report was generated.

### Export Options

| Option | Description |
|--------|-------------|
| Download PDF | Save the report as a styled PDF file |
| Copy PNG | Copies a PNG screenshot to your clipboard for quick pasting |
| Export CSV | Downloads raw report data for spreadsheet analysis |
| Export JSON | Downloads structured report data |
| PDF Receipts | Batch export individual order receipts as PDF files |

### Report Templates

Save reusable report configurations for one-click generation:

1. Click **+ New Template**
2. Name it (e.g., "Weekly Walmart Summary")
3. Select sections, time period, and retailer filter
4. Save

Load any template to instantly populate settings and generate. Templates are managed in **Settings > Reports**.

### Share to Discord

Click **Share to Discord** to send the report to your configured webhook. The message includes an embed with key stats and a PNG screenshot attachment. Configure your webhook in **Settings > Reports**.

### PDF Receipt Export

Export individual order receipts as PDF files:

1. Set a **PDF Save Folder** in Settings > Data
2. Click **PDF Receipts** in the report export bar
3. Confirmation is required for batches over 50 orders

### CSV Column Customization

Customize which columns appear in CSV exports via **Settings > Data**. Available columns: Date, Retailer, Order ID, Item, Quantity, Amount, Per-Unit Cost, Tracking Number, Carrier, Tracking URL, Email, Status, Address, and ETA.

---

## 13. Inventory and Portfolio

Track your inventory, costs, and profits with the full-featured inventory management system.

### Portfolio Overview

The Portfolio page provides a unified view of your inventory with three sub-tabs: Stock, Sales, and Insights.

**KPI Summary Bar:** Market Value, Cost Basis, Profit/Loss, ROI percentage, and Item Count.

#### Stock Tab

View and manage all inventory items.

**Controls:** Search by name, filter by category (All Items, Price-Tracked, Manual Only), sort by name/quantity/investment/date, toggle between table and grid view, and adjust display density.

**Adding Items:**

*Manual:* Click **+ Add Item** and enter the SKU, name, quantity, cost per unit, current market value, condition, and optionally a TCGPlayer URL for price tracking.

*Import from Orders:* Click **Import** to select items from your order history. Items are added with the order price as cost basis.

**Cost Lots:** Each inventory item can have multiple cost lots, tracking separate purchase quantities at different prices. This enables accurate FIFO or weighted-average cost basis calculation when logging sales.

**Item Details:** Click any item to see its product image, price history chart, cost versus market value comparison, associated orders, and a Log Sale button.

#### Sales Tab

Track items you have sold.

**Summary Cards:** Items Sold, Total Revenue, Total Cost Basis, Realized Profit/Loss, and Average Margin.

**Platform Filter:** All, eBay, TCGPlayer, Mercari, Facebook, Local, Other.

**Logging a Sale:**

1. Click **Log Sale** on any inventory item
2. Enter quantity sold and sale price
3. Select the platform
4. Fees are auto-calculated based on platform presets (configurable in Settings)
5. Add date and optional notes
6. Click Save

Profit is calculated automatically using your cost basis method (FIFO or weighted average). Inventory quantities update accordingly.

**Returns:** Process returns to restore inventory and reverse fee calculations.

**Charts:** Profit Waterfall chart and Top Movers chart visualize your sales performance.

#### Insights Tab

Automated intelligence about your inventory:

- **Key Metrics** — Four-column display of portfolio health indicators
- **Portfolio Value Chart** — Value trend over time
- **Aging Buckets** — How long items have been in stock
- **Sell-Through Rate** — How quickly items move
- **Category Breakdown** — Distribution by product type
- **Actionable Alerts** — Recommendations such as items to restock, slow movers to discount, or price drops to investigate

### Batch Operations

Select multiple items for bulk actions: Log Bulk Sale, Batch Export, or Batch Delete.

### Legacy Inventory

If you used the original inventory system (v1), your data is preserved. The v2 system includes enhanced lot tracking, structured fee calculations, and a full transaction ledger.

---

## 14. TCG Price Tracker

Monitor TCGPlayer prices for your trading card inventory.

### Adding Items

**By URL:** Click **+ Add Item**, paste a TCGPlayer product URL, and the item is added with its current price fetched automatically.

**By Search:** Click **Search by Name**, type a product name, and select from up to 20 candidates shown with images, set names, market prices, and confidence scores. Link a search result to an existing inventory item or add it as new.

### Price Monitoring

Items with TCGPlayer links display current market price, price trend indicator (up or down), quantity held, and last refresh time.

### Auto-Refresh

| Interval | Best For |
|----------|----------|
| Manual Only | Occasional checking |
| Every 5-15 min | Active monitoring during releases |
| Every 30-60 min | Regular daily tracking |
| Every 6 hours | Passive long-term tracking |

### Proxy Support

For heavy monitoring, set up proxies to avoid rate limiting:

1. Click **Manage Proxies**
2. Create a new proxy list
3. Paste your proxies (one per line, supports HTTP and SOCKS formats)
4. Select the list as active

### TCG Analytics

View price change data across your tracked items: 1-day change, 7-day change, and 30-day change. Batch matching can automatically link your inventory items to TCGPlayer listings.

### Sorting and Views

Sort by name, value (high or low), quantity (high or low), or most recently added. Toggle between grid and list view.

---

## 15. Settings Reference

Settings are organized into tabs, accessed from the sidebar.

### General

**Data Mode:** Switch between IMAP and Discord modes.

**Theme:** Toggle between Dark and Light mode.

**Accent Color:** Choose from preset colors (Purple, Blue, Green, Red, Orange, Pink) or enter a custom hex code. The accent applies across all UI elements.

**Auto-Sync on Launch:** Automatically sync recent emails when the app starts.

**Auto-Sync Interval:** How often auto-sync runs (5 to 120 minutes).

**Sync on Startup:** Enable or disable automatic sync at launch.

**Auto-Resume Delay:** How long to wait before retrying a paused sync (1 to 60 minutes, or off). Retries up to 3 times.

**Deep Scan:** Search all emails in the date range rather than using targeted patterns.

**Flex Save Folder:** Choose where flex card screenshots are saved.

**Walkthrough:** Replay the onboarding tutorial.

### License

View license key (masked), plan type, status, activation date, expiration date, and days remaining. Disconnect your license to deactivate on this device.

### Data

**Export Options:**
- Export JSON — Full data backup
- Export CSV — Orders with configurable columns
- Export PDFs — Batch order receipts (set save folder first)

**Date Range:** Scope exports to a specific window.

**Column Selection:** Toggle which columns appear in CSV exports.

**Import:**
- Import CSV — Bulk import email accounts
- Import EML — Parse raw .eml email files for testing

**Clear Data:**
- Clear Orders — Remove orders by timeframe (7, 14, 30, 60, 90 days, or all)
- Clear All Data — Full reset (requires double confirmation)

### Jig Detection

Group orders from jigged (modified) addresses together.

**Built-in Leetspeak Patterns:** Automatically decodes common substitutions:

| Character | Decoded As |
|-----------|-----------|
| 1 | i |
| 3 | e |
| 0 | o |
| @ or 4 | a |
| $ or 5 | s |
| 7 | t |
| 8 | b |
| 9 | g |

**Custom Patterns:** Add your own substitutions (e.g., `Mainne=Main`).

**AYCD Expressions:** Paste AYCD jig expressions (e.g., `%cMain,Maain,Mainn%`).

**Manual Linking:** View and unlink manually linked addresses. Link addresses by dragging in Delivery Hub > By Address view.

### Reports

**Discord Webhook URL:** Paste your webhook for report and flex sharing. Test to verify.

**Report Templates:** Manage saved templates.

### SKU Overrides

Map product names to custom SKU identifiers. These merge with built-in mappings (your overrides take priority). Useful for normalizing item names that appear differently across retailers or email formats.

---

## 16. Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Jump to search bar (on retailer pages) |
| `Escape` | Close modals or clear search |
| `Enter` | Activate license, save edits, trigger searches |
| `Ctrl/Cmd + Click` | Multi-select drops or orders |

---

## 17. Best Practices

**Security:** Always use app-specific passwords. Never enter your regular email password into any third-party application.

**Sync:** Enable auto-sync on launch to keep data current. For large mailboxes, set auto-resume to 5-10 minutes to handle connection interruptions gracefully.

**Account Health:** Check Account Stats weekly to identify underperforming accounts early. Accounts with declining stick rates or high decline rates may need attention before they become problematic.

**Jig Detection:** Enable jig detection to see your true stick rate per address. Without it, jigged address variants appear as separate accounts.

**Inventory:** Import confirmed orders to inventory to track real profit and loss. Use cost lots to accurately track items purchased at different prices.

**Reports:** Create templates for your weekly or monthly reports. Generate with one click and share to Discord or export as PDF.

**Dashboard:** Hide retailer cards you do not use. A cleaner dashboard helps you focus on what matters.

**Discord Mode:** Set up server-side forwarding by assigning webhooks to watched channels. Orders forward automatically even when SOLUS is closed. Map your profiles to enable @mention tagging in forwarded orders.

**Live Track:** Use date range search to check real-time FedEx tracking status. Clear the cache if results seem outdated.

**Flex Cards:** Set a flex save folder in Settings to avoid the download dialog every time. Images are also automatically copied to your clipboard.

---

## 18. Troubleshooting

### Sync Issues

**Sync not finding emails?**
Check that the date range includes the order dates. Try "Rescue from Spam" as emails may have been filtered. Verify the app password is correct. Open the Sync Log for detailed error messages. If using iCloud, ensure IMAP access is enabled in your iCloud settings.

**Sync keeps pausing?**
Connection interruptions are common with large mailboxes. Enable auto-resume in Settings to automatically retry after a delay. If the problem persists, try syncing a smaller date range.

**Sync is very slow?**
iCloud is the slowest provider due to conservative rate limits. Gmail with large mailboxes may take several minutes. Deep Scan mode is significantly slower than targeted mode. Consider syncing smaller date ranges.

### Order Issues

**Orders showing wrong status?**
Re-sync the affected date range to pull the latest email updates. Status depends on retailer email timing; some retailers delay shipping notifications.

**Duplicate orders appearing?**
SOLUS merges orders by order ID. If duplicates appear, they likely have different order IDs. Check the original emails to verify.

**Wrong price or item name on Walmart orders?**
SOLUS uses multiple extraction strategies for Walmart pricing. If the wrong amount appears, re-sync the affected date. The parser prioritizes the order total section over promotional savings amounts.

### Analytics Issues

**High cancellation rate?**
Check Account Stats to identify problematic accounts or addresses. Review jig detection settings. Use the Risk Score to surface high-risk accounts.

**Charts not loading?**
Switch to a different tab and back. Ensure enough data exists for the selected period.

### Discord Issues

**Discord forwarding not working?**
Re-assign the webhook in ACO Panel Settings (change to None, then back). Wait 60 seconds for the bot to pick up the change. Verify the webhook URL is valid with the Test button.

**Profile @mentions not tagging?**
Ensure the profile name matches exactly (case-insensitive). Wait 5 minutes after adding a new mapping for the bot cache to refresh. Verify the Discord User ID is correct (17-20 digits).

**Declined orders counted as cancellations?**
Update to version 2.3.3 or later, which correctly distinguishes payment declines from true cancellations. Existing misclassified orders are automatically reclassified on update.

### Live Track Issues

**Live Track showing stale data?**
Click **Clear Cache** and run a new search.

**No tracking data found?**
Live Track currently supports FedEx shipments. UPS and USPS tracking data comes from email parsing only.

### General Issues

**App won't start after update?**
On Windows, Smart App Control may block unsigned installers. Right-click the installer, select Properties, and check Unblock, or temporarily disable Smart App Control in Windows Settings > Privacy & Security > Windows Security.

**License validation failed?**
Check your internet connection. SOLUS has a 30-minute offline grace period. If the issue persists, try disconnecting and re-activating your license.

---

## 19. Glossary

| Term | Definition |
|------|-----------|
| ACO | Auto-Checkout. Automated purchasing via Discord bots. |
| App Password | A unique password generated by your email provider specifically for third-party apps. Different from your login password. |
| Cost Basis | The total amount paid for inventory items, used to calculate profit when selling. |
| Deep Scan | An IMAP sync mode that searches all emails rather than using targeted patterns. |
| Decline | A failed payment attempt by an ACO bot. Does not count against stick rate. |
| Drop | A group of orders placed on the same date for the same retailer. |
| ETA | Estimated Time of Arrival for a shipped package. |
| FIFO | First In, First Out. A cost basis method where the oldest inventory is assumed sold first. |
| Flex Card | A styled visual summary of a drop, designed for sharing. |
| IMAP | Internet Message Access Protocol. The standard for accessing email from a server. |
| Jig | A modified shipping address using character substitutions to appear unique to retailers. |
| Leetspeak | Character substitutions (e.g., 1 for i, 3 for e) commonly used in jigged addresses. |
| Lot | A quantity of inventory purchased at a specific cost. Used for accurate cost basis tracking. |
| Profile | A named identity used by an ACO bot, mapped to a Discord user for tracking. |
| SKU | Stock Keeping Unit. A unique identifier for a product. |
| Stick Rate | The percentage of orders that were confirmed versus total attempted. Higher is better. |
| Tier | A performance classification (Diamond, Perfect, Good, Okay, At Risk) based on stick rate. |
| WAVG | Weighted Average. A cost basis method using the average cost across all lots. |
| Webhook | A Discord URL that receives automated messages from SOLUS. |

---

## Support

Need help or want to share feedback?

1. Go to **Settings > General**
2. Click **Send Feedback**
3. Describe your issue
4. Optionally attach debug logs and screenshots
5. Include your Discord username or email for follow-up

---

*SOLUS v4.0 — Built for resellers, by resellers.*
