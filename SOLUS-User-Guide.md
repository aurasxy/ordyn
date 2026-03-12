# SOLUS User Guide v3.0
### Order Analytics for Resellers

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Data Modes](#data-modes)
3. [Dashboard](#dashboard)
4. [IMAP Accounts & Sync](#imap-accounts--sync)
5. [Discord ACO Integration](#discord-aco-integration)
6. [Retailer Pages](#retailer-pages)
7. [Delivery Hub](#delivery-hub)
8. [Live Track](#live-track)
9. [Analytics](#analytics)
10. [Account Stats](#account-stats)
11. [Reports](#reports)
12. [Inventory Management](#inventory-management)
13. [TCG Price Tracker](#tcg-price-tracker)
14. [Settings](#settings)
15. [Tips & Tricks](#tips--tricks)

---

## Getting Started

### Activation
When you first launch SOLUS, you'll be prompted to enter your license key.

Enter your key and click **Activate License**. Once activated, you'll have full access to all features.

### License Details

After activation you can view your license info in **Settings > License**:
- License key (masked)
- Plan type
- Status (active/expired)
- Activation and expiration dates
- Days remaining (color-coded: green > 30 days, orange > 7, yellow > 3, red when expired)

Click **Disconnect License** to log out of your license on this device.

### Onboarding Walkthrough

After activation, a guided walkthrough tutorial will appear automatically on first launch. The walkthrough covers five steps:

1. **Welcome** - Overview of SOLUS and what it does
2. **Accounts** - How to connect your email accounts via IMAP
3. **Sync** - How to pull in order data from your emails
4. **Dashboard** - Navigating the main dashboard and retailer cards
5. **Analytics** - Understanding your charts, stick rate, and performance metrics

Each step highlights the relevant part of the UI and explains how to use it. You can skip the walkthrough at any time, or replay it later from **Settings > General > Show Walkthrough**.

### First Steps
1. **Choose your data mode** - IMAP (email sync) or Discord (ACO bot sync)
2. **Connect your data source** - Add email accounts or link your Discord
3. **Run your first sync** - Pull in your order data
4. **Explore your data** - View orders by retailer, check analytics, and track deliveries

---

## Data Modes

SOLUS supports two data import methods. You choose your mode in **Settings > General**.

### IMAP Mode (Email Sync)
- Connects directly to your email accounts via IMAP
- Parses order confirmations, shipping updates, and delivery notifications
- Tracks full order lifecycle: Confirmed > Shipped > Delivered
- Enables Delivery Hub, Live Track, and carrier analytics
- Best for: complete order tracking with delivery data

### Discord Mode (ACO Bot Sync)
- Syncs orders captured by Discord auto-checkout bots (Alpine, Valor, Hayha, Stellara, Refract, Shikari, TSB, etc.)
- Orders pulled from the SOLUS Discord relay server
- Tracks: Confirmed, Cancelled, Declined statuses
- Enables ACO Panel with profile mappings and webhook forwarding
- Best for: monitoring ACO bot checkouts across profiles

### Switching Modes
1. Go to **Settings > General**
2. Click **IMAP Mode** or **Discord Mode**
3. Confirm the switch (your orders for the other mode are preserved separately)

When you switch modes, the sidebar navigation updates to show only relevant pages. IMAP mode shows Accounts and Delivery Hub; Discord mode shows Discord sync and the ACO Panel.

### Source Filter
On the Dashboard, a **source filter bar** lets you toggle between:
- **All Sources** - Show everything
- **Email (IMAP)** - Only email-synced orders
- **Discord** - Only Discord-synced orders

This filter applies across the dashboard, retailer pages, and analytics.

---

## Dashboard

The Dashboard gives you a quick overview of all your orders across retailers.

### Retailer Cards
Each supported retailer has a card showing:
- **Confirmed** - Orders successfully placed
- **Cancelled** - Orders that were cancelled
- **Shipped** - Orders in transit (hidden in Discord mode)
- **Delivered** - Orders that have arrived (hidden in Discord mode)

In Discord mode, "Shipped" shows as **Declined** instead.

**Click any retailer card** to jump to that retailer's detailed page.

### Customizable Dashboard

Click the **Customize** gear icon in the top-right corner of the dashboard to personalize your layout.

**Retailer Card Toggles:**
Show or hide individual retailer cards based on which retailers you actively use:
- Walmart
- Target
- Pokemon Center
- Sam's Club
- Costco
- Best Buy

**Stats Section Toggles:**
Show or hide the Overall Statistics bar or Quick Stats bar.

Your layout preferences are **saved automatically** and persist across sessions. Toggle cards on and off at any time without losing any underlying data.

### Dashboard Alerts

An alerts bar appears at the top of the dashboard when there are items that need your attention:

- **Low Stick Rate Warning** - "X accounts below 50% stick rate" - Click to jump to Account Stats
- **Overdue Deliveries** - "X orders awaiting delivery past ETA" - Click to jump to Delivery Hub
- **Recent Cancellations** - "X orders cancelled in last 24h" - Click to view cancelled orders

Each alert is clickable and navigates you to the relevant page. Alerts can be **dismissed per session** by clicking the X. They reappear on your next launch if the conditions still apply.

### Quick Stats Bar

A persistent quick stats bar is displayed below the alerts showing at-a-glance numbers:
- **In Transit** - Total packages currently on the way
- **Arriving Today** - Deliveries expected today
- **Spending This Month** - Total confirmed order value for the current month
- **Delivered This Week** - How many packages arrived in the last 7 days

Each stat is clickable and navigates to the relevant page.

### Statistics Bar
View aggregated totals:
- Total orders across all retailers
- Total amount spent
- Overall stick rate
- Confirmed / Cancelled / Shipped / Delivered counts

### Time Period Filter
Toggle between **7D**, **30D**, **90D**, or **All** to filter the dashboard data.

### Navigation Badges
The sidebar shows order count badges next to each retailer name, so you can see at a glance which retailers have the most activity.

---

## IMAP Accounts & Sync

Connect your email accounts to automatically sync order confirmations, shipping updates, and delivery notifications.

### Supported Providers
| Provider | IMAP Server | App Password Required |
|----------|-------------|----------------------|
| Gmail | imap.gmail.com | Yes |
| Yahoo | imap.mail.yahoo.com | Yes (2FA required) |
| Outlook/Hotmail | outlook.office365.com | Yes (or regular password) |
| iCloud | imap.mail.me.com | Yes |

Provider is auto-detected from your email address.

### Adding an Account

1. Click **+ Add Account**
2. Select your email provider (or let it auto-detect)
3. Enter your email address
4. Enter your **App Password** (not your regular password)
5. Click **Test Connection** to verify
6. Click **Add Account**

> **Need help with App Passwords?** Click the help link next to each provider for setup instructions.

### Provider-Specific Help

When adding an account or when a connection test fails, SOLUS displays provider-specific instructions.

**Gmail:**
- Enable IMAP in Gmail settings (Settings > Forwarding and POP/IMAP)
- Create an App Password at [myaccount.google.com](https://myaccount.google.com) under Security > 2-Step Verification > App Passwords
- Use the generated 16-character password in SOLUS

**Outlook / Hotmail:**
- Enable IMAP in Outlook settings
- If you have 2FA enabled, generate an App Password
- Use your app password (or regular password if 2FA is off)

**Yahoo:**
- Go to [login.yahoo.com](https://login.yahoo.com) and navigate to Account Security
- Generate an App Password for "Other App"
- Use the generated password in SOLUS

**iCloud:**
- Go to [appleid.apple.com](https://appleid.apple.com) and sign in
- Under Security, generate an app-specific password
- Use that password in SOLUS

All provider help links open externally in your default browser.

### Account Management

Each account in the list shows:
- Email address with provider badge (Gmail/Yahoo/Outlook/iCloud)
- Editable nickname (click to rename, max 30 chars)
- Last sync time or "Never synced"
- Order count for that account
- Action buttons: Test Connection, View Sync Log, Sync, Edit Password, Delete

### Syncing Emails

Once an account is added, you have several sync options:

| Button | Description |
|--------|-------------|
| **Sync Recent** | Syncs from your last sync date (or last 7 days if first sync) |
| **Sync All** | Full historical sync with custom date range |
| **Rescue from Spam** | Finds order emails in spam and moves them to inbox |

### Sync Progress

During sync you'll see:
- Progress bar with percentage
- Current status message
- **Pause** button (yellow) - Pause after current batch
- **Stop** button (red) - Stop immediately

### Paused Syncs & Auto-Resume

If a sync pauses (due to connection issues), you'll see:
- Yellow highlight on the account
- "Paused (X remaining)" indicator
- **Auto-resume countdown** if enabled
- **Resume** button to continue manually

Auto-resume retries up to 3 times before stopping. Configure the interval in Settings > General (1, 5, 10, 15, 30, or 60 minutes; default: 1 minute).

### Auto-Sync on Launch

When enabled in Settings, SOLUS automatically syncs all accounts on startup, pulling orders from each account's last sync date (or 7 days back if never synced).

### Bulk Import

Have multiple accounts? Click **Import CSV** to bulk import accounts from a CSV file.

### Sync Log

Click **View Sync Log** on any account to see detailed IMAP diagnostics. The log captures connection events, email counts, parsing results, and any errors encountered.

---

## Discord ACO Integration

SOLUS integrates with Discord auto-checkout bots to track orders captured in your Discord server channels.

### Supported ACO Bots
- Alpine
- Valor
- Hayha
- Stellara
- Refract
- Shikari
- TSB
- Generic (auto-detected)

### Linking Your Discord Account

1. Go to **Settings > Discord** (or the Discord nav item)
2. Click **Generate Link Token** - a 6-character code is created
3. Go to your Discord server and run `/link <token>` with the SOLUS bot
4. Once linked, your Discord username appears and channels are loaded

### ACO Panel

The ACO Panel is your hub for managing Discord checkout data. It has two tabs: **Users** and **Settings**.

#### Users Tab

The Users tab shows all your Discord profiles grouped by Discord user.

**Profile List:**
- Each user card shows: Discord username, profile count, total order count
- Click a user card to expand their detail view
- Unmapped profiles appear separately at the bottom with a **Link** button

**User Detail View:**
- Full profile breakdown with per-site stats (orders, stick rate, spending)
- Recent orders (up to 5 per site) with status icons
- **+ Add Profile** button to map additional profiles to this Discord user
- **Send Test Forward** button to test webhook forwarding for a profile
- **Remove** button to unlink a profile mapping

**Profile Mapping:**
When you click **+ Link Profile** or the **Link** button on an unmapped profile:
1. Enter the profile name (must match exactly what the ACO bot uses)
2. Enter the Discord User ID (17-20 digit number)
3. Optionally enter the Discord username
4. Click Save

Profile mappings are stored server-side and used for @mention tagging when orders are forwarded via webhook.

**Searching & Filtering:**
- Search by Discord username, user ID, or profile name
- Filter: All, Mapped only, Unmapped only

#### Settings Tab

The Settings tab has five sections:

**1. Saved Webhooks**
Manage your Discord webhook URLs:
- Click **+ Add** to save a new webhook
- Each webhook shows: name, masked URL, Test/Edit/Delete buttons
- Maximum 10 webhooks per user
- URL must be a valid Discord webhook URL (`discord.com/api/webhooks/...`)
- **Test** sends a test embed to verify the webhook works

**2. Watched Channels**
Assign webhooks to each channel the bot is monitoring:
- Shows all channels added via the SOLUS Discord bot
- Dropdown to assign a saved webhook to each channel
- Status indicator: checkmark when assigned, "Synced" briefly after saving
- **Bot forwarding** indicator (green checkmark + "Bot forwarding") appears when the server-side bot has forwarding active for that channel - this means orders forward even when SOLUS is closed
- Click **Refresh** to reload the channel list

**3. Auto-Forward**
- Toggle to automatically forward new orders to assigned webhooks when SOLUS syncs
- **Forward Declined/Cancelled** sub-toggle - include or exclude declined/cancelled orders
- When enabled and a profile mapping exists, forwarded embeds include an @mention

**4. Sync Settings**
- **Last Sync** display showing time ago and order count
- **Sync Now** button to manually sync Discord orders
- **Refresh Images** to re-map product images to orders
- **Clear Orders** to delete all Discord-source orders (red, requires confirmation)

**5. Diagnostics**
- Webhook status: shows count of saved webhooks or "None configured"
- Discord link status: shows "Linked (username)" or "Not linked"

**6. Recent Forward Log**
- Audit trail of forwarded orders (up to 50 most recent shown, 200 stored)
- Each entry shows: status icon (sent/skipped/failed), item name, profile, time ago
- "@mentioned" badge when a Discord mention was included
- **Clear** button to wipe the log

### Server-Side Bot Forwarding

When you assign a webhook to a channel in the Settings tab, SOLUS syncs the webhook URL to the server. The Discord bot then handles forwarding automatically:

- **Orders forward instantly** when captured by the bot (no delay)
- **Works with SOLUS closed** - the bot runs independently on the server
- **@mention support** - if a profile mapping exists, the forwarded embed tags the Discord user
- **Forwarded embed includes**: status (confirmed/declined/cancelled), retailer, item name, profile name, product image, and SOLUS branding
- The bot's channel cache refreshes every 60 seconds, so new webhook assignments take effect within a minute

### Auto-Sync (Discord Mode)

When in Discord mode, SOLUS checks for new orders every 30 seconds:
- If auto-sync is enabled and enough time has elapsed since the last sync (default: 15 minutes), it fetches new orders
- New orders are auto-forwarded if the auto-forward toggle is on
- A toast notification shows the count of new orders and forwards

### Discord Webhook Sharing (Flex & Reports)

Separately from ACO forwarding, you can share individual orders and reports to Discord:

**Drop Flex:**
1. Navigate to any retailer page
2. Click the **Discord icon** on an order card
3. A styled embed is sent to your configured webhook with item name, image, amount, status, and retailer

**Report Share:**
1. Generate a report from the Reports page
2. Click **Share to Discord**
3. An embed with key stats plus a PNG screenshot is sent to your webhook

Configure your main webhook URL in **Settings > Reports**.

---

## Retailer Pages

Each retailer has its own dedicated page with detailed order information.

### Supported Retailers
- **Walmart** - Blue theme
- **Target** - Red theme
- **Pokemon Center** - Yellow/Amber theme
- **Sam's Club** - Navy theme
- **Costco** - Red theme
- **Best Buy** - Blue theme

### Page Layout

Each retailer page has three view levels:

#### Drops View (Landing)
Orders are grouped by "drops" (order date). Each drop card shows:
- Up to 3 product images
- Item name previews (up to 4 items)
- Account count
- Status counts (confirmed/cancelled/shipped/delivered)
- Stick rate percentage
- Total spent for that drop
- **Resync** button to re-fetch emails for that date
- **Flex** button to create a visual drop card for sharing

Click a drop to expand into the detail view.

#### Items Grid
Below the drops, an items grid shows each unique product:
- Product image
- Item name
- Quantity ordered
- Stick rate percentage
- Total spend

Click an item to filter the orders list to just that product.

#### Orders List
The full order list with sorting, filtering, and multiple view options.

### Statistics Grid
Quick view at the top of each retailer page:
- Confirmed / Cancelled / Shipped / Delivered counts
- Total Orders
- Total Spent

### Pagination Info
"Showing X of Y orders" indicator above the order list, updating as you filter or search.

### Search
Search orders by item name, order ID, amount, tracking number, or date.

Press **/** to quickly jump to the search bar.

### Advanced Filters

Click the **Advanced Filters** toggle to expand the filtering panel:

- **Date Range** - Start and end date pickers
- **Amount Range** - Min and max dollar amount
- **Carrier Dropdown** - Filter by shipping carrier (UPS, FedEx, USPS, etc.)
- **Status Checkboxes** - Confirmed, Cancelled, Shipped, Delivered
- **Has Tracking Toggle** - Show only orders with/without tracking
- **Account / Email Filter** - Filter by email account

When filters are active, a **badge** shows the count (e.g., "Filters (3)"). Click **Clear All Filters** to reset.

Filters **persist per retailer** - switching tabs and back keeps your filters. They reset when you close the app.

### View Modes
Toggle between **Grid** and **List** view.

**Column Toggles (List view):**
- Item name
- Email/Account
- ETA
- Shipping address
- Tracking number
- Per-unit price

### Period Filter
Filter orders by: All, 30 days, 60 days, 90 days.

### Sorting
Sort by: Date, Order ID, Amount, Status, Item Name. Click a column header to toggle ascending/descending.

### Flex to Discord

Each order card includes a **Discord icon button**. Click it to share that order as a "drop flex" embed. The embed includes:
- Item name and image
- Order amount and status
- Retailer name
- SOLUS logo branding

### Bulk Operations

**Multi-Select:**
- Hold **Ctrl/Cmd** and click to select multiple drops
- Use **Select All** checkbox to select all visible orders
- A **floating action bar** appears at the bottom showing the count

**Bulk Actions:**
- **Mark Delivered** - Mark all selected orders as delivered
- **Export CSV** - Export selected orders to a CSV file

### Target-Specific Features

Target retailer pages have additional features:
- **Fetch Images** button on drops without product images (scrapes Target.com)
- **Auto-Spread Images** - fills missing item images from other drops with the same product
- **Clear Images** - removes fetched images (hover to reveal)

---

## Delivery Hub

Track all your incoming packages in one place. Available in IMAP mode.

### Four Tabs

#### In Transit
Shows all packages currently on the way.

**Summary Cards:**
- **Today** - Packages arriving today (teal)
- **This Week** - Arriving within 7 days (indigo)
- **In Transit** - All shipped orders (yellow)
- **Alerts** - Delivery issues (orange)

Click any card to filter to that category.

**View Modes:**
- **Timeline** - Organized by delivery date (sections: Today, Tomorrow, This Week, Later, No ETA)
- **By Address** - Grouped by shipping address
- **By Retailer** - Grouped by store

**Delivery Card Details:**
- Retailer badge (W/T/P/S/C/B with retailer color)
- Product image
- Item name
- Shipping address
- Carrier and tracking number
- ETA with visual formatting (arriving today/tomorrow/overdue)
- **Track** button - opens carrier tracking in browser
- **Mark Delivered** button
- Expandable section with full order details

**Alerts:**
- **Stale Shipments** - Orders shipped 7+ days ago without delivery
- **Delayed Orders** - Orders past their expected delivery date

#### Recently Delivered
View orders that have already arrived.

Filter by: Last 7 Days, 30 Days, 90 Days, Year, All Time

#### Calendar View
Visual calendar showing deliveries by date.
- Navigate months with arrows
- Up to 3 orders shown per day with item names
- "+N more" indicator for busy days
- Click any day to see full delivery details in a popup
- **Today** button jumps to current date
- Integrates with Live Track data for most accurate ETAs

#### Live Track
See [Live Track](#live-track) section below.

### Bulk Mark Delivered

1. **Checkboxes** appear next to each shipped item
2. Use **Select All** to select everything
3. A **floating action bar** shows the count of selected items
4. Click **Mark Delivered** to mark all selected as delivered

### Address Linking
In **By Address** view, drag and drop addresses to link them together. Useful for jig addresses that should be grouped.

---

## Live Track

Real-time package tracking for FedEx shipments. Available in the Delivery Hub's Live Track tab.

### How It Works

Live Track uses a manual search approach to conserve API credits:

1. Set your **date range** (defaults to last 30 days)
2. Click **Search** to fetch live tracking data for all FedEx orders in that range
3. Results display with real-time statuses, updated ETAs, and status descriptions

### Status Filters
Filter results by: All, In Transit, Out for Delivery, Delivered, Exception, Pending, No Data

### Sorting
Sort by: ETA (soonest/latest), Status, Retailer, Date (oldest/newest)

### Status Mapping
Live Track maps FedEx statuses to SOLUS statuses:
- `DELIVERED` - marked as delivered
- `IN_TRANSIT`, `OUT_FOR_DELIVERY`, `PICKED_UP` - shown as shipped/in transit

### Cache
Live Track data is cached locally. Clear the cache in **Settings** if results seem stale.

---

## Analytics

Deep dive into your ordering performance with comprehensive charts and insights.

### Summary Cards

At the top of the Analytics page:
- **Total Orders** - Combined order count for the selected period
- **Confirmed** - Number of confirmed (non-cancelled) orders
- **Total Spent** - Dollar amount across all confirmed orders
- **Stick Rate** - Percentage of orders confirmed vs. total placed

### Sub-Tabs

Analytics is divided into four sub-tabs:
- **Overview** - Summary stats and main charts
- **Trends** - Spending, stick rate, and cancel rate over time
- **Patterns** - Ordering heatmap and carrier analytics
- **Insights** - Top performers, worst performers, biggest drop days

### Retailer Filter Tabs

Filter all analytics data by retailer:
- **All** - Aggregate data across every retailer
- **Walmart**, **Target**, **Pokemon Center**, **Sam's Club**, **Costco**, **Best Buy**

### Period Filter
- **7 Days**, **30 Days**, **90 Days**, **1 Year**, **All Time**

### Chart Toggle Bar

Use the toggle bar to show or hide individual chart sections:
- Spending, Stick Rate, Cancel Rate, Order Volume, Retailer Compare, Patterns, Carriers, Insights

### Charts

#### 1. Spending Over Time
**Line chart** showing daily/weekly spending. When "All" retailers is selected, each retailer gets its own color-coded line.

#### 2. Stick Rate Trend
**Line chart** tracking your stick rate (confirmed / total) over time in the app's accent color.

#### 3. Cancel Rate Trend
**Line chart** showing daily cancellation rate in red. Helps identify spike patterns.

#### 4. Order Volume
**Stacked bar chart** - green bars for confirmed, red for cancelled. Shows both volume and success rate at a glance.

#### 5. Retailer Comparison
**Horizontal bar chart** (only visible when "All" retailers tab selected). Toggle between three metrics:
- **Stick Rate** - confirmation percentage per retailer
- **Orders** - total order count
- **Spending** - total dollar amount

#### 6. Ordering Patterns Heatmap
**Heatmap** showing order distribution by day of the week:
- Per-retailer tabs to see patterns for each store
- Color intensity based on volume
- Peak drop day insights (e.g., "Your busiest day at Walmart is Tuesday")

#### 7. Carrier Performance
Three visualizations:
- **Doughnut chart** - carrier distribution (UPS, FedEx, USPS, etc.)
- **Bar chart** - average delivery time per carrier in days
- **Stats table** - total shipments, average transit time, on-time percentage

### Period Comparison

Click the **Compare** toggle to overlay the previous period's data as a dashed line on Spending, Stick Rate, and Cancel Rate charts. For example, viewing 30 Days with Compare enabled overlays the prior 30-day period.

### Performance Insights

A dedicated panel showing your top and bottom performers:
- **Top Items by Stick Rate** - Which products have the highest confirmation rate (min 3 orders)
- **Top Items by Spend** - Where you're spending the most
- **Top Items by Volume** - Most-ordered products
- **Worst Performers** - Items with the highest cancellation rates
- **Biggest Drop Days** - Dates with the most orders

Clickable item names navigate directly to the retailer page with that item searched.

---

## Account Stats

Analyze performance by individual email account (IMAP mode) or Discord profile (Discord mode).

The page title changes based on mode: **Account Stats** (IMAP) or **Profile Stats** (Discord).

### How to Use

1. Select a **Retailer** (or All)
2. Select a **Time Period** (7D, 30D, 90D, All, or Custom date range)
3. View account/profile performance cards

### View Modes
Toggle between **Grid** (cards) and **List** (rows) view.

### Metrics Per Account

Each card shows:
- **Rank** - #1 (gold), #2 (silver), #3 (bronze)
- **Email/Profile** (with editable nickname)
- **Stick Rate %** with tier color and trend arrow (up/flat/down)
- **Tier Label** - Diamond, Perfect, Good, Okay, or At Risk
- **Benchmark** - comparison vs tier average ("vs tier avg: +5.2%")
- **Score** badge (0-100, color-coded)
- **Mini outcome bar** - visual confirmed/total ratio
- **Detailed metrics**: confirmed/total orders, total spent, avg order value, last order date
- Expandable mini order list

**Discord Mode extras:**
- Bot type badge
- Decline count and decline rate
- Health score (if declines > 0)

**Pokemon Center extras:**
- Base address grouping
- Variant count and email count
- Expandable variants showing address variant, email, order count, spent

### Tier System

| Tier | Stick Rate | Color | Requirements |
|------|-----------|-------|--------------|
| Diamond | 100% | Ice-blue glow | 3+ orders AND 100% stick |
| Perfect | 80%+ | Purple | - |
| Good | 60%+ | Jade green | - |
| Okay | 40%+ | Orange | - |
| At Risk | Below 40% | Red | - |

### Account Risk Score

Each account receives a composite **Risk Score from 0 to 100**:

| Factor | Weight | Description |
|--------|--------|-------------|
| Stick Rate | 40% | Higher stick rate = higher score |
| Order Volume Confidence | 25% | More orders = more reliable (log scale, 20 orders = full) |
| Recent Trend | 20% | Improving stick rate boosts score |
| Decline Rate | 15% | High decline rate penalizes score |

**Score Color Coding:**
- **Green (80-100)** - Healthy account
- **Yellow (60-79)** - Acceptable, monitor
- **Orange (40-59)** - At risk, reduce volume
- **Red (0-39)** - High risk, investigate or retire

### Recommendations

Accounts with 5+ orders receive actionable recommendations:
- **Performing** (green) - Stick rate 80%+, decline rate < 10%
- **Needs Attention** (yellow) - Stick rate 70-80%, decline 10-20%, or inactive 14+ days
- **Consider Retiring** (red) - Stick rate < 50%, decline 20%+
- Accounts with < 5 orders show "Need more data"

### Summary Cards

At the top of the page:
- Total Accounts/Profiles count
- Base Addresses (Pokemon Center only)
- Average Stick Rate (with delta vs prior period)
- Total Spent (IMAP) or Total Declines (Discord)
- Diamond/Perfect account counts
- Need Attention and Consider Retiring counts

### Tier Distribution Bar

A visual bar showing the count of accounts in each tier, giving you a quick picture of overall account health.

### Sorting Options
- Stick Rate (High to Low)
- Order Count (High to Low)
- Total Spent (High to Low)
- Account Name (A-Z)
- Risk Score (High to Low / Low to High)

### Advanced Filters

Click the filter icon to open the advanced filter modal:
- **Minimum Stick Rate** slider (0-100%)
- **Minimum Orders** slider
- **Date Range** picker
- **Tier Chips** - filter to specific tiers
- Filter badge shows active filter count

---

## Reports

Generate, export, and share detailed reports from your order data.

### Report Templates

Save reusable report configurations so you can generate the same report with one click.

**Creating a Template:**
1. Click **+ New Template**
2. Give it a name (e.g., "Weekly Walmart Summary")
3. Select which sections to include
4. Choose the time period (7D, 30D, 90D, 1Y, All)
5. Optionally set a retailer filter
6. Save the template

### Available Report Sections

- **Summary Stats** - Total orders, confirmed, cancelled, stick rate, total spent
- **Retailer Breakdown** - Per-retailer order counts and spend
- **Top Performers** - Best items by stick rate, spend, and volume
- **Account Scores** - Risk scores and stick rates per account
- **Carrier Stats** - Carrier distribution and average delivery times
- **Stick Rate Trend** - Line chart over the selected period
- **Spending Chart** - Line chart of spending over time

### Generating Reports

Click **Generate** on any saved template. SOLUS compiles the data and presents a **styled PDF preview** in-app matching SOLUS branding.

### Export Options

| Option | Description |
|--------|-------------|
| **Download PDF** | Save the report as a styled PDF file |
| **Copy to Clipboard** | Copies a PNG screenshot for quick pasting |
| **Export CSV** | Downloads raw report data as CSV for spreadsheets |
| **Export JSON** | Downloads structured report data as JSON |

### CSV Export Settings

Customize which columns appear in CSV exports. Go to **Settings > Data** to toggle columns:
- Date, Retailer, Order ID, Item, Quantity, Amount, Per-unit Cost, Tracking, Carrier, Tracking URL, Email, Status, Address, ETA

### PDF Receipt Export

Export individual order receipts as PDF files:
1. Set a **PDF Save Folder** in Settings > Data
2. Click **Export PDFs** to batch-export order receipts
3. Confirmation required for batches over 50

### Share to Discord

Click **Share to Discord** to send the report to your webhook. The message includes:
- An embed with key stats (order count, stick rate, total spent, top item)
- A PNG screenshot as an attachment
- SOLUS branding

Configure your webhook in **Settings > Reports** before using this feature.

---

## Inventory Management

Track your inventory, costs, and profits.

### Portfolio Tab

#### Summary Cards
- **Market Value** - Current total value
- **Cost Basis** - What you paid
- **Profit/Loss** - Green when positive
- **ROI %** - Return on investment
- **Item Count** - Total unique items

#### Adding Inventory

**Manual Add:**
1. Click **+ Add Item**
2. Enter SKU, name, quantity, cost per unit
3. Optionally set current market value
4. Optionally link to a TCGPlayer URL for price tracking
5. Click Save

**Import from Orders:**
1. Click **Import from Orders**
2. Select a retailer to see orders grouped by drop date
3. Select items to add
4. Items are added with order price as cost basis

#### View Modes
Toggle between Grid and List view. Sort by name, quantity, investment, or date added.

#### Search
Filter inventory by item name or set name in real-time.

#### Item Details
Click any item to see:
- Full product image
- Price history chart
- Cost vs. market value
- Associated orders
- Log Sale button

### Sales History Tab

Track items you've sold.

#### Summary
- Items Sold
- Total Revenue
- Total Cost Basis
- Realized P&L
- Average Margin %

#### Logging a Sale
1. Click **Log Sale** on any inventory item
2. Enter quantity sold
3. Enter sale price
4. Select platform (eBay, TCGPlayer, Mercari, Facebook, Local, Other)
5. Add date and optional notes
6. Click Save

Your profit is automatically calculated.

---

## TCG Price Tracker

Monitor TCGPlayer prices for your trading card inventory.

### Adding Items

**By URL:**
1. Click **+ Add Item**
2. Paste a TCGPlayer URL
3. Item is added and price fetched automatically

**By Search:**
1. Click **Search by Name**
2. Type a product name (500ms debounce)
3. Up to 20 candidates shown with images, set names, market prices, and confidence scores
4. Select a match to add or link to an existing inventory item

### Price Monitoring

Items with TCGPlayer links automatically show:
- Current market price
- Price trend indicator (up/down)
- Quantity held
- Last refresh time

#### Auto-Refresh Options
| Interval | Best For |
|----------|----------|
| Manual Only | Occasional checking |
| Every 5-15 min | Active monitoring |
| Every 30-60 min | Regular tracking |
| Every 6 hours | Passive tracking |

#### Proxy Support
For heavy monitoring, set up proxies to avoid rate limits:
1. Click **Manage Proxies**
2. Create a new proxy list
3. Paste your proxies (one per line)
4. Select the list as active

### TCG Analytics
View price change analytics:
- 1-day change
- 7-day change
- 30-day change

---

## Settings

Configure SOLUS to work your way. Settings are organized into tabs.

### General Tab

#### Data Mode
Switch between IMAP and Discord modes. See [Data Modes](#data-modes) for details.

#### Theme
Toggle between **Dark** and **Light** mode. Stored locally and applied instantly.

#### Accent Colors
Personalize the look of SOLUS:

**Preset Colors:** Purple (default), Blue, Green, Red, Orange, Pink

**Custom Color:** Enter any hex color code (e.g., `#FF6B35`).

The accent color applies across all UI elements including buttons, charts, sidebar highlights, and Discord embeds.

#### Auto-Sync on Launch
Automatically sync recent emails when the app starts.

#### Auto-Resume
Automatically retry paused syncs (1-60 minutes, default: 1 minute). Retries up to 3 times.

#### Flex PNG Folder
Choose where to save flex card screenshots.

#### Walkthrough
Click **Show Walkthrough** to replay the onboarding tutorial.

### License Tab
View your license details:
- License key (masked)
- Plan type and status
- Activation and expiration dates
- Days remaining (color-coded)
- **Disconnect License** button

### Data Tab

#### Export
- **Export JSON** - Download your data as a backup
- **Export CSV** - Download orders with configurable columns
- **Export PDFs** - Batch export order receipts (set save folder first)

#### Date Range
Set from/to dates to scope exports to a specific window.

#### Export Column Selection
Toggle which columns appear in CSV exports.

#### Import
- **Import CSV** - Import accounts from a CSV file
- **Import EML** (Dev Tools) - Test email parsing with raw .eml files

#### Clear Data
- **Clear Orders** - Remove orders by timeframe (7, 14, 30, 60, 90 days, or all)
- **Clear All Data** - Full reset with double confirmation

### Jig Detection Tab

Group orders from jigged addresses together.

#### Built-in Patterns
Automatically decodes common leetspeak:
- `1` to `i`, `3` to `e`, `0` to `o`
- `@` or `4` to `a`, `$` or `5` to `s`
- `7` to `t`, `8` to `b`, `9` to `g`

#### Custom Patterns
Add your own substitutions:
```
Mainne=Main
Streeeet=Street
```

#### AYCD Expressions
Paste AYCD jig expressions:
```
%cMain,Maain,Mainn,Maiinn%
```

#### Manual Linking
Link addresses manually by dragging in Delivery Hub > By Address view. View and unlink addresses in this settings tab.

### Reports Tab
- **Discord Webhook URL** - Paste your webhook for Discord sharing
- **Test Webhook** - Send a test message
- **Report Templates** - Manage saved templates

### SKU Overrides
Map product names to custom SKU identifiers. Merged with built-in mappings. Useful for normalizing item names across different email formats.

---

## Tips & Tricks

### Keyboard Shortcuts
| Key | Action |
|-----|--------|
| `/` | Jump to search (on retailer pages) |
| `Escape` | Close modals or clear search |
| `Enter` | Activate license, save edits, trigger searches |
| `Ctrl/Cmd + Click` | Multi-select drops |

### Best Practices

1. **Use App Passwords** - Never use your real email password. Create app-specific passwords for security.

2. **Sync Regularly** - Enable auto-sync on launch to keep data fresh.

3. **Set Auto-Resume** - For large mailboxes, set a 5-10 minute auto-resume to handle connection hiccups.

4. **Track Your Inventory** - Import orders to inventory to track true P&L.

5. **Use Jig Detection** - Enable it to see your real stick rate per address.

6. **Check Analytics Weekly** - Monitor trends to optimize your buying strategy.

7. **Use Discord Webhooks** - Share your wins and reports with your group.

8. **Customize Your Dashboard** - Hide retailer cards you don't use. Click the gear icon to toggle.

9. **Use Report Templates** - Create templates for weekly or monthly reports. Generate with one click and share to Discord or export as PDF.

10. **Set Up Server-Side Forwarding** (Discord Mode) - Assign webhooks to watched channels in the ACO Panel Settings. The bot forwards orders automatically, even when SOLUS is closed.

11. **Map Your Profiles** (Discord Mode) - Link profile names to Discord user IDs in the ACO Panel Users tab. Forwarded orders will @mention the mapped user.

12. **Use Live Track** - Check real-time FedEx tracking status for your packages in the Delivery Hub's Live Track tab.

### Troubleshooting

**Sync not finding emails?**
- Check date range includes the order dates
- Try "Rescue from Spam" - emails might be filtered
- Verify app password is correct
- Check the Sync Log for detailed error messages

**Orders showing wrong status?**
- Re-sync to pull latest updates
- Status updates depend on retailer email timing

**High cancellation rate?**
- Check Account Stats to identify problematic accounts/addresses
- Review jig detection settings
- Look at the Account Risk Score to surface high-risk accounts

**Discord forwarding not working?**
- Re-assign the webhook in the ACO Panel Settings (change to None, then back to your webhook)
- Wait 60 seconds for the bot to pick up the new assignment
- Check that you see "Bot forwarding" indicator next to the channel
- Verify the webhook URL is still valid with the Test button

**Profile @mentions not tagging?**
- Ensure the profile name matches exactly (case-insensitive)
- Wait 5 minutes after adding a new mapping (bot caches mappings)
- Verify the Discord User ID is correct (17-20 digits)

**Charts not loading?**
- Try switching to a different tab and back
- Make sure enough data exists for the selected period

**Live Track showing stale data?**
- Clear the cache in Settings
- Re-run the search with your date range

---

## Support

Need help? Have feedback?

1. Go to **Settings > General**
2. Click **Send Feedback**
3. Describe your issue
4. Optionally include debug logs and screenshots
5. Add your Discord or email for follow-up

---

*SOLUS v3.0 - Built for resellers, by resellers.*
