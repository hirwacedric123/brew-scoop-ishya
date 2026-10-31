/**
 * Brew & Scoop Stock Management — Frontend
 */

const state = {
  products: [],
  ingredients: [],
  categories: [],
  cupInventory: null,
  dashboard: null,
  selectedProductId: null,
  deleteProductId: null,
  deleteIngredientId: null,
  recipeDraft: [],
  salesPreset: "today",
  salesReportMode: "date",
  salesFrom: null,
  salesTo: null,
  salesReport: null,
  shiftsReport: null,
  selectedSalesDate: null,
  selectedShiftId: null,
  historySellerId: "",
  historyShiftPreset: "today",
  selectedHistoryShiftId: null,
  salesSellerId: "",
  sellers: [],
  cart: [],
  paymentMethod: null,
  selectedTableId: null,
  serviceTables: [],
  posMode: false,
  sellCategory: "",
  sellSearch: "",
  keepSellCategory: false,
  users: [],
  deleteUserId: null,
  deleteCategoryId: null,
  voidCheckoutRef: null,
  historySaleGroups: null,
  currentUser: window.CURRENT_USER || null,
  currentBusiness: window.CURRENT_BUSINESS || null,
  memberships: window.MEMBERSHIPS || [],
  businesses: [],
  sellerShift: null,
  charts: {},
  lots: [],
};

// Pending cart-removal action awaiting admin-password confirmation.
let pendingCartRemoval = null;

const VIEW_TITLES = {
  dashboard: "Dashboard",
  products: "Products",
  ingredients: "Ingredients",
  sell: "Point of Sale",
  restock: "Restock",
  history: "History",
  sales: "Sales Reports",
  activity: "Activity Log",
  businesses: "Businesses",
  admin: "Administration",
  reconcile: "My Shift",
  profile: "My Profile",
};

/* ── UI State Persistence ────────────────────────────────────────────────── */

const UI_STORAGE_KEY = "brew_scoop_ui_v1";

function currentBusinessStorageId() {
  return state.currentBusiness?.id ?? window.CURRENT_BUSINESS?.id ?? null;
}

function currentUiViewId() {
  const activeView =
    document.querySelector(".view.active")?.id?.replace("view-", "") || "";
  if (activeView === "admin") {
    const tab = document.querySelector(".admin-tab.active")?.dataset.adminTab;
    if (tab === "activity" || tab === "businesses") return tab;
  }
  return activeView;
}

function saveUIState() {
  try {
    const activeView = currentUiViewId();
    localStorage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        businessId: currentBusinessStorageId(),
        cart: state.cart,
        paymentMethod: state.paymentMethod,
        selectedTableId: state.selectedTableId,
        posMode: state.posMode,
        activeView,
        sellCategory: state.sellCategory,
        salesPreset: state.salesPreset,
        salesReportMode: state.salesReportMode,
        salesFrom: state.salesFrom,
        salesTo: state.salesTo,
        historyShiftPreset: state.historyShiftPreset,
        historySellerId: state.historySellerId,
        salesSellerId: state.salesSellerId,
      })
    );
  } catch (_) {
    // Ignore storage errors (private mode, quota exceeded, etc.)
  }
}

function clearPosLocalState() {
  state.cart = [];
  state.selectedTableId = null;
  state.paymentMethod = "momo";
  state.sellCategory = "";
  state.keepSellCategory = false;
  state.historySellerId = "";
  state.salesSellerId = "";
}

function restoreUIState() {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    const currentBiz = currentBusinessStorageId();
    const savedBiz = saved.businessId ?? null;
    const sameBusiness =
      currentBiz == null || savedBiz == null || String(savedBiz) === String(currentBiz);

    if (!sameBusiness) {
      clearPosLocalState();
      return null;
    }

    if (Array.isArray(saved.cart) && saved.cart.length)
      state.cart = saved.cart;
    if (saved.paymentMethod) state.paymentMethod = saved.paymentMethod;
    if (saved.selectedTableId) state.selectedTableId = saved.selectedTableId;
    if (typeof saved.posMode === "boolean") state.posMode = saved.posMode;
    if (saved.sellCategory) {
      state.sellCategory = saved.sellCategory;
      state.keepSellCategory = true;
    }
    if (saved.salesPreset) state.salesPreset = saved.salesPreset;
    if (saved.salesReportMode) state.salesReportMode = saved.salesReportMode;
    if (saved.salesFrom) state.salesFrom = saved.salesFrom;
    if (saved.salesTo) state.salesTo = saved.salesTo;
    if (saved.historyShiftPreset)
      state.historyShiftPreset = saved.historyShiftPreset;
    if (saved.historySellerId) state.historySellerId = saved.historySellerId;
    if (saved.salesSellerId) state.salesSellerId = saved.salesSellerId;

    return saved.activeView || null;
  } catch (_) {
    return null;
  }
}

function applyRestoredPosMode() {
  if (!state.posMode) return;
  document.getElementById("view-sell")?.classList.add("pos-mode");
  document.getElementById("btn-pos-mode")?.classList.add("active");
  const posBar = document.getElementById("pos-bar");
  if (posBar) posBar.hidden = false;
  const subtitle = document.getElementById("sell-subtitle");
  if (subtitle)
    subtitle.textContent =
      "Counter mode — larger tiles and keyboard shortcuts";
}

function applyRestoredPaymentMethod() {
  if (!state.paymentMethod) return;
  document.querySelectorAll("#payment-methods .payment-chip").forEach((chip) => {
    chip.classList.toggle(
      "active",
      chip.dataset.method === state.paymentMethod
    );
  });
  syncPaymentCheckoutUi();
}

function isSeller() {
  return state.currentUser?.role === "seller";
}

function canViewCost() {
  const role = state.currentUser?.role;
  return role === "admin" || role === "stock_manager" || role === "supervisor";
}

function canEditCost() {
  const role = state.currentUser?.role;
  return role === "admin" || role === "stock_manager";
}

function formatMargin(p) {
  if (p.margin == null) return "—";
  const pct = p.margin_pct != null ? ` (${p.margin_pct}%)` : "";
  return `${fmt.format(p.margin)}${pct}`;
}

function canViewShiftReports() {
  const role = state.currentUser?.role;
  return role === "admin" || role === "supervisor" || role === "stock_manager";
}

function canAccessView(viewId) {
  const role = state.currentUser?.role;
  const isPlatform = !!state.currentUser?.is_platform_admin;
  if (viewId === "profile") return true;
  if (viewId === "businesses") return isPlatform;
  if (viewId === "activity") {
    return (
      isPlatform ||
      role === "admin" ||
      role === "supervisor" ||
      role === "stock_manager"
    );
  }
  if ((role === "admin" || role === "supervisor") && (viewId === "sell" || viewId === "reconcile")) {
    return false;
  }
  if (!isSeller()) return true;
  return viewId === "sell" || viewId === "reconcile";
}

const ROLE_LABELS = {
  admin: "Administrator",
  supervisor: "Supervisor",
  stock_manager: "Stock Manager",
  seller: "Seller",
};

function hasOpenShift() {
  return !!state.sellerShift?.has_open_shift;
}

function canCloseShift() {
  return !!state.sellerShift?.can_close || !!state.sellerShift?.shift?.can_close;
}

function isShiftSupervisor() {
  return (state.sellerShift?.my_role_on_shift || state.sellerShift?.shift?.my_role_on_shift) === "supervisor";
}

function getJoinableShift() {
  return state.sellerShift?.joinable_shift || null;
}

const fmt = new Intl.NumberFormat("en-RW", { style: "currency", currency: "RWF", maximumFractionDigits: 0 });
const fmtNum = new Intl.NumberFormat("en-RW");

const PAYMENT_LABELS = { momo: "MoMo", cash: "Cash", visa: "Visa", credit: "Credit" };

const DEFAULT_CATEGORY_NAMES = ["Shared Cups", "Individuals"];

function isDefaultCategory(name) {
  return DEFAULT_CATEGORY_NAMES.some((n) => n.toLowerCase() === (name || "").toLowerCase());
}

function categoryStockTypeLabel(usesCupStock) {
  return usesCupStock
    ? '<span class="badge badge-category">Shared cups</span>'
    : '<span class="badge badge-stock ok">Individual</span>';
}

function paymentMethodLabel(method) {
  return PAYMENT_LABELS[method] || method || "—";
}

function sellerLabel(transaction) {
  return esc(transaction.seller_name || "—");
}

function clearPaymentMethod() {
  state.paymentMethod = null;
  document.querySelectorAll("#payment-methods .payment-chip").forEach((chip) => chip.classList.remove("active"));
  syncPaymentCheckoutUi();
}

function syncPaymentCheckoutUi() {
  const isCredit = state.paymentMethod === "credit";
  const notesReq = document.getElementById("sell-notes-required");
  const hint = document.getElementById("sell-credit-hint");
  const notes = document.getElementById("sell-notes");
  const btn = document.getElementById("btn-complete-sale");
  if (notesReq) notesReq.hidden = !isCredit;
  if (hint) hint.hidden = !isCredit;
  if (notes) {
    notes.placeholder = isCredit
      ? "Customer name (required for credit)"
      : "Customer name, order ref...";
  }
  if (btn && !btn.disabled) {
    btn.textContent = isCredit ? "Record Credit" : "Receive Payment";
  }
}

async function loadServiceTables() {
  try {
    state.serviceTables = await api("/api/tables");
    populateSellTableSelect();
  } catch (err) {
    toast(err.message, "error");
  }
}

function populateSellTableSelect() {
  const select = document.getElementById("sell-table");
  if (!select) return;
  const current = state.selectedTableId ? String(state.selectedTableId) : select.value;
  select.innerHTML =
    '<option value="">Choose a table...</option>' +
    (state.serviceTables || [])
      .map(
        (t) =>
          `<option value="${t.id}">${esc(t.name)}</option>`
      )
      .join("");
  if (current && [...select.options].some((o) => o.value === current)) {
    select.value = current;
    state.selectedTableId = Number(current);
  } else {
    state.selectedTableId = null;
  }
}

function initSellTableSelect() {
  const select = document.getElementById("sell-table");
  if (!select) return;
  select.addEventListener("change", () => {
    state.selectedTableId = select.value ? Number(select.value) : null;
    saveUIState();
  });
}

function tableLabel(row) {
  return esc(row?.table_name || "—");
}

function initPaymentMethods() {
  document.querySelectorAll("#payment-methods .payment-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#payment-methods .payment-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.paymentMethod = chip.dataset.method;
      syncPaymentCheckoutUi();
      saveUIState();
    });
  });
  syncPaymentCheckoutUi();
}

const UI_ICONS = {
  revenue: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
  sales: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 16l4-4 4 4 5-6"/></svg>`,
  stock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  box: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
  chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 16l4-4 4 4 5-6"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
};

function emptyState(icon, title, message, compact = false) {
  if (compact) {
    return `<div class="empty-state empty-state-compact">
      <div class="empty-state-icon">${icon}</div>
      <div>
        <strong>${esc(title)}</strong>
        <p>${esc(message)}</p>
      </div>
    </div>`;
  }
  return `<div class="empty-state">
    <div class="empty-state-icon">${icon}</div>
    <strong>${esc(title)}</strong>
    <p>${esc(message)}</p>
  </div>`;
}

function statCard(cls, icon, label, value, sub, extraStyle = "", featured = false) {
  const featuredCls = featured ? " stat-card-featured" : "";
  return `<div class="stat-card ${cls}${featuredCls}"${extraStyle ? ` style="${extraStyle}"` : ""}>
    <div class="stat-icon">${icon}</div>
    <div class="stat-content">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
      <div class="stat-sub">${sub}</div>
    </div>
  </div>`;
}

function statCardComparison(cls, icon, label, value, sub, currentNum, priorNum, priorLabel, featured = false) {
  const featuredCls = featured ? " stat-card-featured" : "";

  let deltaHtml = "";
  if (priorLabel != null) {
    if (priorNum > 0) {
      const pct = ((currentNum - priorNum) / priorNum) * 100;
      const dir = Math.abs(pct) < 0.5 ? "flat" : pct > 0 ? "up" : "down";
      const arrow = dir === "up" ? "↑" : dir === "down" ? "↓" : "—";
      const sign = pct > 0 ? "+" : pct < 0 ? "" : "";
      const pctStr = dir === "flat" ? "no change" : `${sign}${Math.abs(pct) >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;
      deltaHtml = `<div class="stat-comparison">
        <span class="stat-delta stat-delta-${dir}">${arrow} ${pctStr}</span>
        <span class="stat-compare-label">vs ${esc(priorLabel)}</span>
      </div>`;
    } else if (currentNum > 0) {
      deltaHtml = `<div class="stat-comparison">
        <span class="stat-delta stat-delta-up">↑ new</span>
        <span class="stat-compare-label">vs ${esc(priorLabel)}</span>
      </div>`;
    } else {
      deltaHtml = `<div class="stat-comparison">
        <span class="stat-delta stat-delta-flat">— no data</span>
        <span class="stat-compare-label">vs ${esc(priorLabel)}</span>
      </div>`;
    }
  }

  return `<div class="stat-card stat-card-v2 ${cls}${featuredCls}">
    <div class="stat-icon">${icon}</div>
    <div class="stat-content">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ""}
      ${deltaHtml}
    </div>
  </div>`;
}

function productInitials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function productCell(name, sub) {
  return `<div class="product-cell">
    <div class="product-avatar">${esc(productInitials(name))}</div>
    <div class="product-cell-text">
      <strong>${esc(name)}</strong>
      <span>${sub}</span>
    </div>
  </div>`;
}

function categoryAccent(name) {
  const palette = ["#c4a574", "#6b8f71", "#5d4037", "#d4a03c", "#8b6f5c", "#7a9e7e", "#a67c52"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}

const CATEGORY_ICONS = [
  { match: /hot|coffee|tea|espresso|latte|cappuccino/i, icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z"/><line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/></svg>` },
  { match: /ice.?cream|gelato|scoop|frozen/i, icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M12 3c2 3 4 5.5 4 8.5a4 4 0 0 1-8 0C8 8.5 10 6 12 3z"/><path d="M8 21h8"/><path d="M9 17h6"/></svg>` },
  { match: /cold|smoothie|juice|iced/i, icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M8 2h8l-1 9H9L8 2z"/><path d="M12 11v6"/><path d="M8 21h8"/><path d="M10 17h4"/></svg>` },
  { match: /snack|pastry|cake|cookie|bread/i, icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M4 14a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2z"/><path d="M8 10V8a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>` },
  { match: /soft.?drink|soda|fizzy|cola/i, icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M9 2h6l1 7H8L9 2z"/><path d="M8 9h8v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V9z"/><path d="M10 5h4"/></svg>` },
  { match: /add.?on|extra|topping|syrup/i, icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>` },
  { match: /cup|shared/i, icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M6 3h12v5a6 6 0 0 1-12 0V3z"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>` },
];

function categoryIcon(name) {
  const match = CATEGORY_ICONS.find((entry) => entry.match.test(name));
  return match ? match.icon : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`;
}

function cartQtyInCategory(categoryName) {
  const key = categoryName.toLowerCase();
  return state.cart.reduce((total, item) => {
    if (item.category.toLowerCase() === key) return total + item.quantity;
    return total;
  }, 0);
}

function getCategoryPriceRange(categoryName) {
  const products = state.products.filter((p) => p.category.toLowerCase() === categoryName.toLowerCase());
  if (!products.length) return null;
  const prices = products.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? fmt.format(min) : `${fmt.format(min)} – ${fmt.format(max)}`;
}

// ── API ────────────────────────────────────────────────────────────────────

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const isFormData =
    typeof FormData !== "undefined" && options.body instanceof FormData;
  if (!isFormData && headers["Content-Type"] == null) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new Error("Session expired");
  }
  if (res.status === 403 && data.must_change_password) {
    window.location.href = "/change-password";
    throw new Error("Password change required");
  }
  if (res.status === 403 && data.must_change_pin) {
    state.currentUser = { ...state.currentUser, must_change_pin: true };
    toast("Set a new personal PIN before continuing.", "error");
    switchView("profile");
    throw new Error(data.error || "PIN change required");
  }
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

// ── Toast ──────────────────────────────────────────────────────────────────

function toast(message, type = "success") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Navigation ─────────────────────────────────────────────────────────────

function initNavigation() {
  document.addEventListener("click", (e) => {
    const trigger = e.target.closest(
      ".nav-item[data-view], .bottom-nav-item[data-view], [data-view].btn, .shift-result-link[data-view]"
    );
    if (!trigger?.dataset.view) return;
    switchView(trigger.dataset.view);
  });

  document.getElementById("btn-menu-toggle")?.addEventListener("click", openMobileNav);
  document.getElementById("btn-more-nav")?.addEventListener("click", openMobileNav);
  document.getElementById("sidebar-overlay")?.addEventListener("click", closeMobileNav);

  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.addEventListener("click", closeMobileNav);
  });

  document.querySelectorAll(".admin-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchAdminTab(btn.dataset.adminTab));
  });
}

function openMobileNav() {
  document.getElementById("sidebar")?.classList.add("open");
  document.getElementById("sidebar-overlay")?.removeAttribute("hidden");
}

function closeMobileNav() {
  document.getElementById("sidebar")?.classList.remove("open");
  document.getElementById("sidebar-overlay")?.setAttribute("hidden", "");
}

function highlightAdminSidebar(tabId) {
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  const sidebarView =
    tabId === "activity" || tabId === "businesses" ? tabId : "admin";
  document
    .querySelector(`.nav-item[data-view="${sidebarView}"]`)
    ?.classList.add("active");
  const mobileTitle = document.getElementById("mobile-view-title");
  if (mobileTitle) {
    mobileTitle.textContent =
      VIEW_TITLES[sidebarView] || VIEW_TITLES.admin || "Brew & Scoop";
  }
}

function switchView(viewId) {
  if (!canAccessView(viewId)) return;

  if (state.currentUser?.must_change_pin && viewId !== "profile") {
    toast("Set a new personal PIN before using the app.", "error");
    viewId = "profile";
  }

  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
  document.querySelectorAll(".bottom-nav-item[data-view]").forEach((n) => n.classList.remove("active"));

  const adminAlias = viewId === "activity" || viewId === "businesses";
  const sectionId = adminAlias ? "admin" : viewId;

  document.getElementById(`view-${sectionId}`)?.classList.add("active");
  document.querySelector(`.nav-item[data-view="${viewId}"]`)?.classList.add("active");
  document.querySelector(`.bottom-nav-item[data-view="${viewId}"]`)?.classList.add("active");

  const mobileTitle = document.getElementById("mobile-view-title");
  if (mobileTitle) mobileTitle.textContent = VIEW_TITLES[viewId] || "Brew & Scoop";

  closeMobileNav();

  if (viewId === "dashboard") loadDashboard();
  if (viewId === "products") loadProducts();
  if (viewId === "ingredients") loadIngredients();
  if (viewId === "sell") {
    if (!state.keepSellCategory) state.sellCategory = "";
    state.keepSellCategory = false;
    loadSellView();
  }
  if (viewId === "restock") loadRestockView();
  if (viewId === "history") {
    if (isSeller()) loadCategories();
    else loadSellers();
    loadHistory();
  }
  if (viewId === "sales") {
    if (!isSeller()) loadSellers();
    syncSalesUiFromState();
    loadSalesViewData();
  }
  if (viewId === "activity") switchAdminTab("activity");
  if (viewId === "businesses") switchAdminTab("businesses");
  if (viewId === "admin") loadAdminView();
  if (viewId === "reconcile") loadReconcileView();
  if (viewId === "profile") loadProfileView();

  saveUIState();
}

function switchAdminTab(tabId) {
  document.querySelectorAll(".admin-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.adminTab === tabId);
  });
  const teamPanel = document.getElementById("admin-panel-team");
  const categoriesPanel = document.getElementById("admin-panel-categories");
  const brandingPanel = document.getElementById("admin-panel-branding");
  const activityPanel = document.getElementById("admin-panel-activity");
  const businessesPanel = document.getElementById("admin-panel-businesses");
  const attendancePanel = document.getElementById("admin-panel-attendance");
  if (teamPanel) teamPanel.hidden = tabId !== "team";
  if (categoriesPanel) categoriesPanel.hidden = tabId !== "categories";
  if (brandingPanel) brandingPanel.hidden = tabId !== "branding";
  if (activityPanel) activityPanel.hidden = tabId !== "activity";
  if (businessesPanel) businessesPanel.hidden = tabId !== "businesses";
  if (attendancePanel) attendancePanel.hidden = tabId !== "attendance";

  if (document.getElementById("view-admin")?.classList.contains("active")) {
    highlightAdminSidebar(tabId);
  }

  if (tabId === "team") loadUsers();
  if (tabId === "categories") loadCategoriesAdmin();
  if (tabId === "branding") loadBrandingAdmin();
  if (tabId === "activity") loadActivityLogs();
  if (tabId === "businesses") loadBusinessesAdmin();
  if (tabId === "attendance") loadAttendance();
  saveUIState();
}

function loadAdminView() {
  const role = state.currentUser?.role;
  const isPlatform = !!state.currentUser?.is_platform_admin;
  if (
    !state.currentUser ||
    (role !== "admin" &&
      role !== "supervisor" &&
      role !== "stock_manager" &&
      !isPlatform)
  ) {
    return;
  }
  const defaultTab =
    role === "admin" ? "team" : role === "stock_manager" ? "activity" : isPlatform ? "businesses" : "attendance";
  const activeTab =
    document.querySelector(".admin-tab.active")?.dataset.adminTab || defaultTab;
  switchAdminTab(activeTab);
}

const DEFAULT_BRANDING = {
  logo_url: "/static/img/logo.png",
  primary_color: "#2c1810",
  accent_color: "#c4a574",
};

const ACTIVITY_DETAIL_LABELS = {
  name: "Name",
  old_name: "Previous name",
  display_name: "Person",
  username: "Username",
  role: "Role",
  role_on_shift: "Shift role",
  category: "Category",
  price: "Sell price",
  cost_price: "Cost price",
  quantity: "Quantity",
  quantity_added: "Qty added",
  new_quantity: "New stock",
  from_quantity: "From stock",
  to_quantity: "To stock",
  diff: "Change",
  unit_cost: "Unit cost",
  total_amount: "Amount",
  total_sales: "Sales total",
  units: "Units",
  units_sold: "Units sold",
  item_count: "Line items",
  primary_color: "Primary color",
  accent_color: "Accent color",
  logo_path: "Logo",
  lines: "Lines",
  lines_voided: "Lines voided",
  payment_method: "Payment",
  settled_method: "Settled via",
  payment_status: "Payment status",
  table_name: "Table",
  table_id: "Table ID",
  business_name: "Business",
  from_business_name: "From business",
  to_business_name: "To business",
  from_business_id: "From business ID",
  to_business_id: "To business ID",
  cash_variance: "Cash variance",
  counted_cash: "Counted cash",
  expected_cash: "Expected cash",
  uses_cup_stock: "Uses cup stock",
  is_active: "Active",
  removed_membership_only: "Removed membership only",
  admin_user_id: "Admin user ID",
  slug: "Slug",
  checkout_ref: "Sale ref",
  notes: "Notes",
  items: "Items",
};

const ACTIVITY_MONEY_KEYS = new Set([
  "price",
  "cost_price",
  "unit_cost",
  "total_amount",
  "total_sales",
  "cash_variance",
  "counted_cash",
  "expected_cash",
]);

const ACTIVITY_SKIP_KEYS = new Set(["table_id"]);

function formatActivityValue(key, value) {
  if (value == null || value === "") return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (key === "payment_method" || key === "settled_method") {
    const method = String(value).toLowerCase();
    return PAYMENT_LABELS[method] || String(value).toUpperCase();
  }
  if (key === "role" || key === "role_on_shift") {
    return String(value).replace(/_/g, " ");
  }
  if (ACTIVITY_MONEY_KEYS.has(key) && Number.isFinite(Number(value))) {
    return fmt.format(Number(value));
  }
  if (key === "quantity_added" && Number.isFinite(Number(value))) {
    const n = Number(value);
    return n > 0 ? `+${fmtNum.format(n)}` : fmtNum.format(n);
  }
  if (key === "diff" && Number.isFinite(Number(value))) {
    const n = Number(value);
    return n > 0 ? `+${fmtNum.format(n)}` : fmtNum.format(n);
  }
  if (Array.isArray(value)) {
    if (!value.length) return null;
    if (typeof value[0] === "object") {
      return value
        .map((item) => {
          const name = item.name || item.product_name || "Item";
          const qty = item.quantity ?? item.qty;
          const total = item.total_amount ?? item.line_total ?? item.total;
          const bits = [name];
          if (qty != null) bits.push(`×${qty}`);
          if (total != null && Number.isFinite(Number(total))) {
            bits.push(fmt.format(Number(total)));
          }
          return bits.join(" ");
        })
        .join(", ");
    }
    return value.map(String).join(", ");
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }
  return String(value);
}

function formatActivityDetails(log) {
  const details =
    log?.details && typeof log.details === "object" ? { ...log.details } : {};
  const rows = [];

  const push = (label, value) => {
    if (value == null || value === "") return;
    rows.push({ label, value });
  };

  if (log?.entity_type && log?.entity_id != null && log.entity_id !== "") {
    const entityLabel =
      log.entity_type === "checkout"
        ? "Sale ref"
        : log.entity_type === "product"
          ? "Product ID"
          : log.entity_type === "user"
            ? "User ID"
            : log.entity_type === "shift"
              ? "Shift ID"
              : log.entity_type === "business"
                ? "Business ID"
                : log.entity_type === "category"
                  ? "Category ID"
                  : "Ref";
    if (!details.checkout_ref && log.entity_type === "checkout") {
      push(entityLabel, log.entity_id);
    } else if (log.entity_type !== "checkout") {
      push(entityLabel, log.entity_id);
    }
  }

  if (details.from_quantity != null && details.to_quantity != null) {
    push(
      "Stock change",
      `${fmtNum.format(details.from_quantity)} → ${fmtNum.format(details.to_quantity)}`
    );
    delete details.from_quantity;
    delete details.to_quantity;
  }

  if (details.from_business_name || details.business_name) {
    if (details.from_business_name && details.business_name) {
      push("Switched", `${details.from_business_name} → ${details.business_name}`);
      delete details.from_business_name;
      delete details.business_name;
      delete details.from_business_id;
      delete details.to_business_id;
    }
  }

  Object.entries(details).forEach(([key, raw]) => {
    if (ACTIVITY_SKIP_KEYS.has(key)) return;
    const formatted = formatActivityValue(key, raw);
    if (formatted == null) return;
    push(ACTIVITY_DETAIL_LABELS[key] || key.replace(/_/g, " "), formatted);
  });

  if (!rows.length) {
    return `<span class="activity-detail-empty">No extra details</span>`;
  }

  return `<dl class="activity-detail-list">${rows
    .map(
      (row) =>
        `<div class="activity-detail-row"><dt>${esc(row.label)}</dt><dd>${esc(
          row.value
        )}</dd></div>`
    )
    .join("")}</dl>`;
}

async function loadActivityLogs() {
  const tbody = document.getElementById("activity-logs-table-body");
  if (!tbody) return;
  showTableSkeleton("activity-logs-table-body", 4, 6);

  const params = new URLSearchParams();
  const from = document.getElementById("activity-from")?.value;
  const to = document.getElementById("activity-to")?.value;
  const action = document.getElementById("activity-action-filter")?.value;
  const userId = document.getElementById("activity-user-filter")?.value;
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (action) params.set("action", action);
  if (userId) params.set("user_id", userId);
  params.set("limit", "150");

  try {
    const data = await api(`/api/activity-logs?${params}`);
    const label = document.getElementById("activity-log-business-label");
    if (label && data.business) {
      label.innerHTML = `Users, actions, and timestamps for <strong>${esc(data.business.name)}</strong>`;
    }

    const actionFilter = document.getElementById("activity-action-filter");
    if (actionFilter && actionFilter.options.length <= 1 && data.actions?.length) {
      const current = actionFilter.value;
      actionFilter.innerHTML =
        `<option value="">All actions</option>` +
        data.actions
          .map((a) => `<option value="${escAttr(a.value)}">${esc(a.label)}</option>`)
          .join("");
      if (current) actionFilter.value = current;
    }

    const userFilter = document.getElementById("activity-user-filter");
    if (userFilter && state.users?.length) {
      const current = userFilter.value;
      userFilter.innerHTML =
        `<option value="">All users</option>` +
        state.users
          .map(
            (u) =>
              `<option value="${u.id}">${esc(u.display_name || u.username)}</option>`
          )
          .join("");
      if (current) userFilter.value = current;
    } else if (userFilter && !state.users?.length) {
      try {
        state.users = await api("/api/admin/users");
        const current = userFilter.value;
        userFilter.innerHTML =
          `<option value="">All users</option>` +
          state.users
            .map(
              (u) =>
                `<option value="${u.id}">${esc(u.display_name || u.username)}</option>`
            )
            .join("");
        if (current) userFilter.value = current;
      } catch (_) {
        /* supervisors may lack user list; keep All users */
      }
    }

    const logs = data.logs || [];
    if (!logs.length) {
      tbody.innerHTML = `<tr><td colspan="4">${emptyState(UI_ICONS.clock, "No activity yet", "Actions for this business will appear here.")}</td></tr>`;
      return;
    }
    tbody.innerHTML = logs
      .map(
        (log) => `
      <tr class="activity-log-row">
        <td class="activity-when">
          <strong>${esc(formatDate(log.created_at))}</strong>
        </td>
        <td>
          <div class="activity-user">
            <strong>${esc(log.user_name || "System")}</strong>
            ${
              log.entity_type
                ? `<span class="activity-entity-type">${esc(
                    String(log.entity_type).replace(/_/g, " ")
                  )}</span>`
                : ""
            }
          </div>
        </td>
        <td><span class="badge badge-category">${esc(log.action_label || log.action)}</span></td>
        <td class="activity-details-cell">${formatActivityDetails(log)}</td>
      </tr>`
      )
      .join("");
  } catch (err) {
    toast(err.message, "error");
    tbody.innerHTML = `<tr><td colspan="4" class="empty-state">${esc(err.message)}</td></tr>`;
  }
}

function closeBusinessSwitcher() {
  const wrap = document.getElementById("brand-business");
  const menu = document.getElementById("business-switcher-menu");
  const trigger = document.getElementById("business-switcher-trigger");
  if (!wrap || !menu) return;
  wrap.classList.remove("is-open");
  menu.hidden = true;
  if (trigger) trigger.setAttribute("aria-expanded", "false");
}

function openBusinessSwitcher() {
  const wrap = document.getElementById("brand-business");
  const menu = document.getElementById("business-switcher-menu");
  const trigger = document.getElementById("business-switcher-trigger");
  if (!wrap?.classList.contains("is-switchable") || !menu) return;
  wrap.classList.add("is-open");
  menu.hidden = false;
  if (trigger) trigger.setAttribute("aria-expanded", "true");
}

function toggleBusinessSwitcher() {
  const menu = document.getElementById("business-switcher-menu");
  if (!menu) return;
  if (menu.hidden) openBusinessSwitcher();
  else closeBusinessSwitcher();
}

function formatBusinessRole(role) {
  if (!role) return "";
  return String(role).replace(/_/g, " ");
}

function renderBusinessSwitcher(memberships, currentBusinessId) {
  const list = memberships || [];
  const wrap = document.getElementById("brand-business");
  const trigger = document.getElementById("business-switcher-trigger");
  const nameEl = document.getElementById("current-business-name");
  if (!wrap || !trigger) return;

  const currentId = currentBusinessId ?? state.currentBusiness?.id;
  const current =
    list.find((m) => String(m.id) === String(currentId)) ||
    state.currentBusiness;
  if (nameEl && current?.name) nameEl.textContent = current.name;

  const canSwitch =
    list.length > 1 || !!state.currentUser?.is_platform_admin;

  wrap.classList.toggle("is-switchable", canSwitch);
  trigger.disabled = !canSwitch;
  trigger.setAttribute(
    "aria-label",
    canSwitch ? "Switch business" : "Current business"
  );
  trigger.setAttribute("aria-haspopup", canSwitch ? "listbox" : "false");

  let menu = document.getElementById("business-switcher-menu");
  let options = document.getElementById("business-switcher-options");

  if (!canSwitch || !list.length) {
    closeBusinessSwitcher();
    if (menu) menu.remove();
    trigger.querySelector(".business-switcher-chevron")?.remove();
    return;
  }

  if (!trigger.querySelector(".business-switcher-chevron")) {
    const chevron = document.createElement("span");
    chevron.className = "business-switcher-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 12 15 18 9"/></svg>';
    trigger.appendChild(chevron);
  }

  if (!menu) {
    menu = document.createElement("div");
    menu.className = "business-switcher-menu";
    menu.id = "business-switcher-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", "Businesses");
    menu.hidden = true;
    menu.innerHTML =
      '<p class="business-switcher-menu-label">Switch business</p><div class="business-switcher-options" id="business-switcher-options"></div>';
    wrap.appendChild(menu);
    options = document.getElementById("business-switcher-options");
  }

  if (!options) return;
  options.innerHTML = list
    .map((m) => {
      const isCurrent = String(m.id) === String(currentId);
      const role = formatBusinessRole(m.role);
      return `
        <button
          type="button"
          class="business-switcher-option${isCurrent ? " is-current" : ""}"
          role="option"
          data-business-id="${m.id}"
          aria-selected="${isCurrent ? "true" : "false"}"
        >
          <span class="business-switcher-option-text">
            <span class="business-switcher-option-name">${esc(m.name)}</span>
            ${
              role
                ? `<span class="business-switcher-option-role">${esc(role)}</span>`
                : ""
            }
          </span>
          <span class="business-switcher-option-check" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="20 6 9 17 4 12"/></svg>
          </span>
        </button>`;
    })
    .join("");
}

async function switchBusiness(businessId) {
  try {
    const data = await api("/api/auth/switch-business", {
      method: "POST",
      body: JSON.stringify({ business_id: Number(businessId) }),
    });
    clearPosLocalState();
    state.currentUser = data.user;
    state.currentBusiness = data.business;
    state.memberships = data.memberships || [];
    window.CURRENT_USER = data.user;
    window.CURRENT_BUSINESS = data.business;
    window.MEMBERSHIPS = data.memberships || [];
    saveUIState();
    const nameEl = document.getElementById("current-business-name");
    if (nameEl && data.business) nameEl.textContent = data.business.name;
    renderBusinessSwitcher(state.memberships, data.business?.id);
    toast(`Switched to ${data.business?.name || "business"}`);
    window.location.reload();
  } catch (err) {
    toast(err.message, "error");
    renderBusinessSwitcher(state.memberships, state.currentBusiness?.id);
  }
}

async function refreshBusinessSwitcherFromMe() {
  try {
    const me = await api("/api/auth/me");
    state.memberships = me.memberships || [];
    window.MEMBERSHIPS = state.memberships;
    if (me.business) {
      state.currentBusiness = me.business;
      window.CURRENT_BUSINESS = me.business;
      const nameEl = document.getElementById("current-business-name");
      if (nameEl) nameEl.textContent = me.business.name;
      applyBusinessBranding(me.business);
    }
    renderBusinessSwitcher(state.memberships, state.currentBusiness?.id);
  } catch (_) {
    /* switcher refreshes on next page load */
  }
}

function normalizeBrandHex(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const withHash = raw.startsWith("#") ? raw : `#${raw}`;
  if (!/^#[0-9A-Fa-f]{6}$/.test(withHash)) return fallback;
  return withHash.toLowerCase();
}

function applyBusinessBranding(business) {
  const biz = business || state.currentBusiness || {};
  const name = biz.name || "Brew & Scoop";
  const primary = normalizeBrandHex(
    biz.primary_color,
    DEFAULT_BRANDING.primary_color
  );
  const accent = normalizeBrandHex(
    biz.accent_color,
    DEFAULT_BRANDING.accent_color
  );
  const logo = biz.logo_url || DEFAULT_BRANDING.logo_url;

  const root = document.documentElement;
  root.style.setProperty("--espresso", primary);
  root.style.setProperty(
    "--espresso-light",
    `color-mix(in srgb, ${primary} 82%, white)`
  );
  root.style.setProperty(
    "--coffee",
    `color-mix(in srgb, ${primary} 72%, white)`
  );
  root.style.setProperty("--caramel", accent);
  root.style.setProperty(
    "--caramel-light",
    `color-mix(in srgb, ${accent} 78%, white)`
  );
  root.style.setProperty("--brand-primary", primary);
  root.style.setProperty("--brand-accent", accent);

  document.querySelectorAll(".brand-logo, .invoice-logo").forEach((img) => {
    img.src = logo;
    img.alt = name;
  });

  const invoiceName = document.getElementById("invoice-business-name");
  if (invoiceName) invoiceName.textContent = name;

  const brandingName = document.getElementById("branding-business-name");
  if (brandingName) brandingName.textContent = name;

  const preview = document.getElementById("branding-logo-preview");
  if (preview) {
    preview.src = logo;
    preview.alt = `${name} logo preview`;
  }

  document.title = `${name} — Stock Management`;
  document
    .querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')
    .forEach((link) => {
      link.href = logo;
    });
}

function syncBrandingColorInputs(primary, accent) {
  const p = normalizeBrandHex(primary, DEFAULT_BRANDING.primary_color);
  const a = normalizeBrandHex(accent, DEFAULT_BRANDING.accent_color);
  const primaryEl = document.getElementById("branding-primary");
  const accentEl = document.getElementById("branding-accent");
  const primaryHex = document.getElementById("branding-primary-hex");
  const accentHex = document.getElementById("branding-accent-hex");
  if (primaryEl) primaryEl.value = p;
  if (accentEl) accentEl.value = a;
  if (primaryHex) primaryHex.value = p;
  if (accentHex) accentHex.value = a;
  updateBrandingPreviewSwatches(p, a);
}

function updateBrandingPreviewSwatches(primary, accent) {
  const preview = document.getElementById("branding-preview");
  if (!preview) return;
  preview.style.setProperty("--preview-primary", primary);
  preview.style.setProperty("--preview-accent", accent);
}

function loadBrandingAdmin() {
  const biz = state.currentBusiness || {};
  const nameEl = document.getElementById("branding-business-name");
  if (nameEl) nameEl.textContent = biz.name || "Business";
  syncBrandingColorInputs(biz.primary_color, biz.accent_color);
  const preview = document.getElementById("branding-logo-preview");
  if (preview) {
    preview.src = biz.logo_url || DEFAULT_BRANDING.logo_url;
    preview.alt = `${biz.name || "Business"} logo preview`;
  }
  const fileInput = document.getElementById("branding-logo-file");
  const uploadBtn = document.getElementById("btn-upload-logo");
  if (fileInput) fileInput.value = "";
  if (uploadBtn) uploadBtn.disabled = true;
}

async function saveBrandingColors(e) {
  e.preventDefault();
  const primary = normalizeBrandHex(
    document.getElementById("branding-primary")?.value,
    DEFAULT_BRANDING.primary_color
  );
  const accent = normalizeBrandHex(
    document.getElementById("branding-accent")?.value,
    DEFAULT_BRANDING.accent_color
  );
  const btn = document.getElementById("btn-save-branding-colors");
  if (btn) btn.disabled = true;
  try {
    const biz = await api("/api/business/branding", {
      method: "PUT",
      body: JSON.stringify({
        primary_color: primary,
        accent_color: accent,
      }),
    });
    state.currentBusiness = { ...state.currentBusiness, ...biz };
    window.CURRENT_BUSINESS = state.currentBusiness;
    applyBusinessBranding(biz);
    syncBrandingColorInputs(biz.primary_color, biz.accent_color);
    toast("Brand colors saved");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function resetBrandingColors() {
  syncBrandingColorInputs(
    DEFAULT_BRANDING.primary_color,
    DEFAULT_BRANDING.accent_color
  );
  applyBusinessBranding({
    ...state.currentBusiness,
    primary_color: DEFAULT_BRANDING.primary_color,
    accent_color: DEFAULT_BRANDING.accent_color,
  });
}

async function uploadBusinessLogo() {
  const fileInput = document.getElementById("branding-logo-file");
  const file = fileInput?.files?.[0];
  if (!file) {
    toast("Choose a logo image first", "error");
    return;
  }
  const btn = document.getElementById("btn-upload-logo");
  if (btn) btn.disabled = true;
  try {
    const form = new FormData();
    form.append("logo", file);
    const biz = await api("/api/business/branding/logo", {
      method: "POST",
      body: form,
    });
    state.currentBusiness = { ...state.currentBusiness, ...biz };
    window.CURRENT_BUSINESS = state.currentBusiness;
    applyBusinessBranding(biz);
    if (fileInput) fileInput.value = "";
    toast("Logo uploaded");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    if (btn) btn.disabled = !document.getElementById("branding-logo-file")?.files?.length;
  }
}

async function removeBusinessLogo() {
  if (!confirm("Remove the custom logo and restore the default?")) return;
  const btn = document.getElementById("btn-remove-logo");
  if (btn) btn.disabled = true;
  try {
    const biz = await api("/api/business/branding/logo", { method: "DELETE" });
    state.currentBusiness = { ...state.currentBusiness, ...biz };
    window.CURRENT_BUSINESS = state.currentBusiness;
    applyBusinessBranding(biz);
    toast("Logo removed");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function onBrandingLogoFileChange() {
  const fileInput = document.getElementById("branding-logo-file");
  const uploadBtn = document.getElementById("btn-upload-logo");
  const preview = document.getElementById("branding-logo-preview");
  const file = fileInput?.files?.[0];
  if (uploadBtn) uploadBtn.disabled = !file;
  if (file && preview) {
    const url = URL.createObjectURL(file);
    preview.src = url;
    preview.onload = () => URL.revokeObjectURL(url);
  }
}

function bindBrandingColorPair(pickerId, hexId) {
  const picker = document.getElementById(pickerId);
  const hex = document.getElementById(hexId);
  if (!picker || !hex) return;

  picker.addEventListener("input", () => {
    hex.value = picker.value;
    updateBrandingPreviewSwatches(
      document.getElementById("branding-primary")?.value,
      document.getElementById("branding-accent")?.value
    );
  });

  hex.addEventListener("change", () => {
    const normalized = normalizeBrandHex(hex.value, picker.value);
    hex.value = normalized;
    picker.value = normalized;
    updateBrandingPreviewSwatches(
      document.getElementById("branding-primary")?.value,
      document.getElementById("branding-accent")?.value
    );
  });
}

async function loadBusinessesAdmin() {
  const tbody = document.getElementById("businesses-table-body");
  if (!tbody) return;
  showTableSkeleton("businesses-table-body", 5, 4);
  try {
    state.businesses = await api("/api/platform/businesses");
    if (!state.businesses.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No businesses yet</td></tr>`;
      return;
    }
    const currentId = state.currentBusiness?.id;
    const oldestId = Math.min(...state.businesses.map((b) => Number(b.id)));
    tbody.innerHTML = state.businesses
      .map((b) => {
        const isCurrent = String(b.id) === String(currentId);
        const isPrimary = Number(b.id) === oldestId;
        return `
      <tr>
        <td><strong>${esc(b.name)}</strong>${isCurrent ? ' <span class="badge badge-stock ok">Current</span>' : ""}${isPrimary ? ' <span class="badge badge-stock">Primary</span>' : ""}</td>
        <td>${esc(b.slug)}</td>
        <td>${fmtNum.format(b.member_count || 0)}</td>
        <td><span class="badge ${b.is_active ? "badge-stock ok" : "badge-stock out"}">${b.is_active ? "Active" : "Inactive"}</span></td>
        <td>
          <div class="table-actions">
            ${
              b.is_active && !isCurrent
                ? `<button type="button" class="btn btn-ghost btn-sm" onclick="switchBusiness(${b.id})">Switch</button>`
                : ""
            }
            <button type="button" class="btn-icon" title="Edit name" onclick="openEditBusiness(${b.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button>
            <button class="btn-icon" title="${b.is_active ? "Deactivate" : "Activate"}" onclick="toggleBusinessActive(${b.id}, ${b.is_active ? "false" : "true"})">
              ${b.is_active ? "Pause" : "Activate"}
            </button>
            ${
              !isPrimary
                ? `<button type="button" class="btn-icon danger" title="Delete" onclick="openDeleteBusiness(${b.id}, '${escAttr(b.name)}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>`
                : ""
            }
          </div>
        </td>
      </tr>`;
      })
      .join("");
  } catch (err) {
    toast(err.message, "error");
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">${esc(err.message)}</td></tr>`;
  }
}

async function toggleBusinessActive(id, makeActive) {
  try {
    await api(`/api/platform/businesses/${id}`, {
      method: "PUT",
      body: JSON.stringify({ is_active: makeActive }),
    });
    toast(makeActive ? "Business activated" : "Business deactivated");
    loadBusinessesAdmin();
    refreshBusinessSwitcherFromMe();
  } catch (err) {
    toast(err.message, "error");
  }
}

function openAddBusiness() {
  const form = document.getElementById("business-form");
  if (!form) return;
  form.reset();
  showModal("business-modal");
  document.getElementById("business-name")?.focus();
}

function openEditBusiness(id) {
  const biz = state.businesses.find((b) => b.id === id);
  if (!biz) return;
  document.getElementById("business-edit-id").value = biz.id;
  document.getElementById("business-edit-name").value = biz.name;
  showModal("business-edit-modal");
  document.getElementById("business-edit-name")?.focus();
}

function openDeleteBusiness(id, name) {
  state.deleteBusinessId = id;
  document.getElementById("delete-business-name").textContent = name;
  showModal("delete-business-modal");
}

async function saveBusiness(e) {
  e.preventDefault();
  const name = document.getElementById("business-name")?.value.trim() || "";
  const adminUsername =
    document.getElementById("business-admin-username")?.value.trim() || "";
  const adminDisplay =
    document.getElementById("business-admin-display")?.value.trim() || "";
  const adminPassword =
    document.getElementById("business-admin-password")?.value || "";
  const adminPin =
    document.getElementById("business-admin-pin")?.value.trim() || "";

  if (!name) {
    toast("Business name is required", "error");
    return;
  }
  if (!adminUsername) {
    toast("Admin username is required", "error");
    return;
  }
  if (!adminPassword) {
    toast("Admin password is required for new users", "error");
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  try {
    await api("/api/platform/businesses", {
      method: "POST",
      body: JSON.stringify({
        name,
        admin_username: adminUsername,
        admin_password: adminPassword,
        admin_display_name: adminDisplay || adminUsername,
        admin_pin: adminPin || undefined,
      }),
    });
    toast("Business created");
    hideModal("business-modal");
    loadBusinessesAdmin();
    refreshBusinessSwitcherFromMe();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function saveBusinessEdit(e) {
  e.preventDefault();
  const id = document.getElementById("business-edit-id")?.value;
  const name = document.getElementById("business-edit-name")?.value.trim() || "";
  if (!id) return;
  if (!name) {
    toast("Business name is required", "error");
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;
  try {
    await api(`/api/platform/businesses/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    });
    toast("Business updated");
    hideModal("business-edit-modal");
    loadBusinessesAdmin();
    refreshBusinessSwitcherFromMe();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function confirmDeleteBusiness() {
  const id = state.deleteBusinessId;
  if (!id) return;
  const btn = document.getElementById("confirm-delete-business");
  if (btn) btn.disabled = true;
  try {
    await api(`/api/platform/businesses/${id}`, { method: "DELETE" });
    toast("Business deleted");
    hideModal("delete-business-modal");
    state.deleteBusinessId = null;
    loadBusinessesAdmin();
    refreshBusinessSwitcherFromMe();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Skeleton loaders ───────────────────────────────────────────────────────

function showTableSkeleton(tbodyId, colCount, rowCount = 5) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = Array(rowCount)
    .fill(0)
    .map(
      () => `
    <tr class="skeleton-row">
      ${Array(colCount).fill('<td><div class="skeleton skeleton-text"></div></td>').join("")}
    </tr>`
    )
    .join("");
}

function showDashboardSkeleton() {
  document.getElementById("dashboard-stats").innerHTML = `
    <div class="stat-card stat-card-v2 stat-card-featured skeleton-stat">
      <div class="skeleton-stat-icon skeleton"></div>
      <div class="stat-content" style="flex:1">
        <div class="skeleton skeleton-text sm" style="width:60%"></div>
        <div class="skeleton skeleton-text lg" style="width:55%"></div>
        <div class="skeleton skeleton-text sm" style="width:45%"></div>
        <div class="skeleton skeleton-text sm" style="width:38%;margin-top:0.5rem"></div>
      </div>
    </div>
    ${Array(4)
      .fill(0)
      .map(
        () => `
    <div class="stat-card stat-card-v2 skeleton-stat">
      <div class="skeleton-stat-icon skeleton"></div>
      <div class="stat-content" style="flex:1">
        <div class="skeleton skeleton-text sm" style="width:55%"></div>
        <div class="skeleton skeleton-text lg" style="width:60%"></div>
        <div class="skeleton skeleton-text sm" style="width:40%"></div>
        <div class="skeleton skeleton-text sm" style="width:48%;margin-top:0.35rem"></div>
      </div>
    </div>`
      )
      .join("")}`;
}

// ── Categories ─────────────────────────────────────────────────────────────

async function loadCategories() {
  try {
    state.categories = await api("/api/categories");
    populateCategorySelects();
  } catch (e) {
    toast(e.message, "error");
  }
}

function populateCategorySelects() {
  const categories = state.categories;
  const names = categories.map((c) => c.name);

  const filter = document.getElementById("product-category-filter");
  if (filter) {
    const current = filter.value;
    filter.innerHTML =
      '<option value="">All Categories</option>' +
      names.map((n) => `<option value="${escAttr(n)}">${esc(n)}</option>`).join("");
    if (names.includes(current)) filter.value = current;
  }

  const historyCategory = document.getElementById("history-category-filter");
  if (historyCategory) {
    const current = historyCategory.value;
    historyCategory.innerHTML =
      '<option value="">All Categories</option>' +
      names.map((n) => `<option value="${escAttr(n)}">${esc(n)}</option>`).join("");
    if (names.includes(current)) historyCategory.value = current;
  }

  const productCategory = document.getElementById("product-category");
  if (productCategory) {
    const current = productCategory.value;
    productCategory.innerHTML =
      '<option value="">Choose a category...</option>' +
      names.map((n) => `<option value="${escAttr(n)}">${esc(n)}</option>`).join("");
    if (names.includes(current)) productCategory.value = current;
  }

  const datalist = document.getElementById("product-name-suggestions");
  if (datalist) {
    const productNames = [...new Set(state.products.map((p) => p.name))];
    datalist.innerHTML = productNames
      .map((n) => `<option value="${escAttr(n)}"></option>`)
      .join("");
  }

  const productName = document.getElementById("product-name");
  if (productName) {
    productName.disabled = categories.length === 0;
    productName.placeholder = categories.length
      ? "Type a name or pick a suggestion"
      : "Add a category in Admin first";
  }
}

function syncCategoryFromProductName() {
  const name = document.getElementById("product-name")?.value.trim();
  const productCategory = document.getElementById("product-category");
  if (!name || !productCategory) return;

  const match = state.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (match) productCategory.value = match.name;
}

// ── Dashboard ──────────────────────────────────────────────────────────────

async function loadDashboard() {
  showDashboardSkeleton();
  try {
    state.dashboard = await api("/api/dashboard");
    renderDashboard(state.dashboard);
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderCategoryBars(categories, valueKey, emptyTitle, emptyMessage) {
  if (!categories.length) {
    return emptyState(UI_ICONS.chart, emptyTitle, emptyMessage, true);
  }
  const maxVal = Math.max(...categories.map((c) => c[valueKey]), 1);
  return `<div class="category-bars">${categories
    .map(
      (c) => `
      <div class="category-bar-item">
        <div class="category-bar-header">
          <span class="category-bar-name">${esc(c.name)}</span>
          <span class="category-bar-meta">${fmt.format(c[valueKey])} · ${c.units ?? c.total_qty ?? 0} units</span>
        </div>
        <div class="category-bar-track">
          <div class="category-bar-fill" style="width:${(c[valueKey] / maxVal) * 100}%;--bar-color:${categoryAccent(c.name)}"></div>
        </div>
      </div>`
    )
    .join("")}</div>`;
}

function destroyChart(key) {
  if (state.charts[key]) {
    state.charts[key].destroy();
    state.charts[key] = null;
  }
}

function renderRevenueChart(dailyData, todayDate) {
  const canvas = document.getElementById("chart-revenue-7d");
  if (!canvas || typeof Chart === "undefined" || !dailyData?.length) return;
  destroyChart("revenue7d");

  const labels = dailyData.map((d) => {
    if (d.date === todayDate) return "Today";
    const dt = new Date(d.date + "T00:00:00");
    return dt.toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" });
  });

  const revenues = dailyData.map((d) => d.revenue);
  const units = dailyData.map((d) => d.units);
  const isToday = dailyData.map((d) => d.date === todayDate);

  const bgColors = isToday.map((t) => (t ? "#c4a574" : "rgba(196,165,116,0.32)"));
  const borderColors = isToday.map((t) => (t ? "#b08040" : "rgba(196,165,116,0.55)"));

  state.charts.revenue7d = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Revenue",
          data: revenues,
          backgroundColor: bgColors,
          borderColor: borderColors,
          borderWidth: 1.5,
          borderRadius: 7,
          borderSkipped: false,
          order: 2,
        },
        {
          label: "Units",
          data: units,
          type: "line",
          borderColor: "rgba(107,143,113,0.7)",
          backgroundColor: "rgba(107,143,113,0.08)",
          borderWidth: 2,
          pointBackgroundColor: "rgba(107,143,113,0.9)",
          pointRadius: 3.5,
          pointHoverRadius: 5,
          fill: true,
          tension: 0.35,
          yAxisID: "yUnits",
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "top",
          align: "end",
          labels: {
            boxWidth: 10,
            boxHeight: 10,
            borderRadius: 3,
            useBorderRadius: true,
            padding: 12,
            font: { size: 11, family: "'Plus Jakarta Sans', system-ui" },
            color: "#7a6a5e",
          },
        },
        tooltip: {
          backgroundColor: "rgba(44,24,16,0.92)",
          titleColor: "rgba(245,230,211,0.7)",
          bodyColor: "#f5e6d3",
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            title: (items) => items[0].label,
            label: (ctx) =>
              ctx.dataset.label === "Revenue"
                ? `  Revenue: ${fmt.format(ctx.parsed.y)}`
                : `  Units: ${fmtNum.format(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: {
            font: { size: 11, family: "'Plus Jakarta Sans', system-ui" },
            color: "#7a6a5e",
            maxRotation: 0,
          },
        },
        y: {
          position: "left",
          grid: { color: "rgba(232,221,208,0.45)", drawTicks: false },
          border: { display: false },
          ticks: {
            font: { size: 11, family: "'Plus Jakarta Sans', system-ui" },
            color: "#7a6a5e",
            padding: 6,
            callback: (v) => fmt.format(v),
          },
        },
        yUnits: {
          position: "right",
          grid: { display: false },
          border: { display: false },
          ticks: {
            font: { size: 11, family: "'Plus Jakarta Sans', system-ui" },
            color: "rgba(107,143,113,0.75)",
            padding: 6,
          },
        },
      },
    },
  });
}

function renderCategoryDonutChart(categories) {
  const canvas = document.getElementById("chart-category-donut");
  const wrap = document.getElementById("chart-cat-donut-wrap");
  destroyChart("categoryDonut");

  if (!canvas || typeof Chart === "undefined") return;

  const hasCats = categories && categories.length > 0;
  if (wrap) wrap.hidden = !hasCats;
  if (!hasCats) return;

  const labels = categories.map((c) => c.name);
  const data = categories.map((c) => c.revenue);
  const total = data.reduce((s, v) => s + v, 0);
  const colors = labels.map((n) => categoryAccent(n));

  state.charts.categoryDonut = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: colors,
          borderColor: "#ffffff",
          borderWidth: 2.5,
          hoverOffset: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: "68%",
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(44,24,16,0.92)",
          titleColor: "rgba(245,230,211,0.7)",
          bodyColor: "#f5e6d3",
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => {
              const pct = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
              return `  ${ctx.label}: ${fmt.format(ctx.parsed)} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

function saleStatusLabel(status) {
  if (status === "credit") return { text: "Credit", cls: "credit" };
  if (status === "voided") return { text: "Voided", cls: "voided" };
  if (status === "paid") return { text: "Paid", cls: "paid" };
  return { text: status || "—", cls: "" };
}

function renderDashboardSaleActivity(d) {
  const body = document.getElementById("dashboard-activity-body");
  const pill = document.getElementById("credit-outstanding-pill");
  const sub = document.getElementById("dashboard-activity-sub");
  if (!body) return;

  if (pill) {
    const amount = d.credit_outstanding || 0;
    const count = d.credit_open_sales || 0;
    if (amount > 0) {
      pill.hidden = false;
      pill.className = "status-pill status-pill-warn";
      pill.textContent = `${fmt.format(amount)} on credit (${count})`;
    } else {
      pill.hidden = true;
    }
  }
  if (sub) {
    sub.textContent = countLabel(d.sale_activity?.length || 0, "recent checkout", "recent checkouts");
  }

  const rows = d.sale_activity || [];
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="8">${emptyState(
      UI_ICONS.sales,
      "No sales yet",
      "Checkouts appear here as soon as sellers record them.",
      true
    )}</td></tr>`;
    return;
  }

  body.innerHTML = rows
    .map((sale) => {
      const status = saleStatusLabel(sale.status_label);
      const products = (sale.items || [])
        .map((item) => `${esc(item.product_name)} ×${item.quantity}`)
        .join(", ");
      const notes = sale.notes ? `<div class="activity-note">${esc(sale.notes)}</div>` : "";
      const settleBtn =
        sale.status_label === "credit" && !sale.is_voided
          ? `<button type="button" class="btn btn-ghost btn-sm" data-settle-credit="${escAttr(
              sale.checkout_ref
            )}">Mark paid</button>`
          : "";
      const settled =
        sale.settled_method && sale.status_label === "paid" && sale.payment_method === "credit"
          ? `<div class="activity-note">Settled via ${esc(paymentMethodLabel(sale.settled_method))}</div>`
          : "";
      return `
        <tr class="dashboard-activity-row status-${status.cls}">
          <td>
            <strong>${esc(formatTime(sale.created_at))}</strong>
            <div class="text-muted activity-date">${esc(
              sale.created_at ? formatDateLabel(sale.created_at.slice(0, 10)) : ""
            )}</div>
          </td>
          <td><strong>${esc(sale.table_name || "—")}</strong></td>
          <td>
            <div class="activity-products">${products || "—"}</div>
            ${notes}${settled}
          </td>
          <td>${esc(sale.seller_name || "—")}</td>
          <td>${esc(paymentMethodLabel(sale.payment_method))}</td>
          <td><span class="sale-status-badge ${status.cls}">${status.text}</span></td>
          <td><strong>${fmt.format(sale.total_amount)}</strong></td>
          <td class="dashboard-activity-actions">${settleBtn}</td>
        </tr>`;
    })
    .join("");
}

function countLabel(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

let pendingSettleCheckoutRef = null;
let pendingSettleMethod = null;

function openSettleCreditModal(checkoutRef) {
  const sale = (state.dashboard?.sale_activity || []).find((s) => s.checkout_ref === checkoutRef);
  pendingSettleCheckoutRef = checkoutRef;
  pendingSettleMethod = null;
  document.querySelectorAll("#settle-payment-methods .payment-chip").forEach((c) => c.classList.remove("active"));
  const summary = document.getElementById("settle-credit-summary");
  if (summary) {
    if (sale) {
      const products = (sale.items || []).map((i) => `${i.product_name} ×${i.quantity}`).join(", ");
      summary.textContent = `${products} · ${fmt.format(sale.total_amount)}${
        sale.notes ? ` · ${sale.notes}` : ""
      }`;
    } else {
      summary.textContent = checkoutRef;
    }
  }
  showModal("settle-credit-modal");
}

async function submitSettleCredit(e) {
  e.preventDefault();
  if (!pendingSettleCheckoutRef) return;
  if (!pendingSettleMethod) {
    toast("Select how it was paid: Cash, MoMo, or Visa", "error");
    return;
  }
  const btn = document.getElementById("btn-settle-credit");
  btn.disabled = true;
  try {
    const data = await api("/api/sales/settle-credit", {
      method: "POST",
      body: JSON.stringify({
        checkout_ref: pendingSettleCheckoutRef,
        payment_method: pendingSettleMethod,
      }),
    });
    hideModal("settle-credit-modal");
    toast(data.message || "Credit marked as paid", "success");
    await loadDashboard();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

function renderDashboard(d) {
  const todayLabel = d.today_date
    ? formatDateLabel(d.today_date)
    : "Today";

  const marginToday =
    d.gross_margin_pct_today != null ? `${d.gross_margin_pct_today}% margin` : "No margin yet";
  document.getElementById("dashboard-stats").innerHTML = `
    ${statCardComparison("revenue", UI_ICONS.revenue, "Sold Today", fmt.format(d.revenue_today),
      `${fmtNum.format(d.units_sold_today)} units · ${todayLabel}`,
      d.revenue_today, d.revenue_yesterday, "yesterday", true)}
    ${statCardComparison("sales", UI_ICONS.sales, "Profit Today", fmt.format(d.gross_profit_today || 0),
      marginToday, null, null, null)}
    ${statCardComparison("month", UI_ICONS.chart, "This Week", fmt.format(d.revenue_week),
      `Profit ${fmt.format(d.gross_profit_week || 0)}${d.gross_margin_pct_week != null ? ` · ${d.gross_margin_pct_week}%` : ""}`,
      d.revenue_week, d.revenue_prev_week, "last week")}
    ${statCardComparison("stock", UI_ICONS.stock, "This Month", fmt.format(d.revenue_month),
      `Profit ${fmt.format(d.gross_profit_month || 0)}${d.gross_margin_pct_month != null ? ` · ${d.gross_margin_pct_month}%` : ""}`,
      d.revenue_month, d.revenue_prev_month, "last month")}
    ${statCardComparison("alert", UI_ICONS.alert, "Stock Alerts", d.low_stock_count,
      `${d.out_of_stock_count} out of stock · Inv ${fmt.format(d.inventory_value)}`, null, null, null)}
  `;

  const labelEl = document.getElementById("low-stock-label");
  if (labelEl) {
    labelEl.textContent = d.low_stock_count ? `${d.low_stock_count} need attention` : "All clear";
    labelEl.className = d.low_stock_count ? "status-pill status-pill-warn" : "status-pill status-pill-ok";
  }

  const lowList = document.getElementById("low-stock-list");
  const lowItems = [...d.low_stock_items];
  if (d.cup_inventory && ["low", "out"].includes(d.cup_inventory.stock_status)) {
    lowItems.unshift({
      id: "cups",
      name: "Serving Cups",
      category: "Shared inventory",
      quantity: d.cup_inventory.quantity,
      reorder_level: d.cup_inventory.reorder_level,
      stock_status: d.cup_inventory.stock_status,
      uses_cup_stock: true,
      is_cup_pool: true,
    });
  }

  if (!lowItems.length) {
    lowList.innerHTML = emptyState(UI_ICONS.check, "All stocked up", "Every product is above reorder level.", true);
  } else {
    lowList.innerHTML = lowItems
      .map(
        (p) => `
      <div class="alert-row">
        <div class="alert-row-info">
          <div class="product-avatar product-avatar-sm">${esc(productInitials(p.name))}</div>
          <div>
            <strong>${esc(p.name)}</strong>
            <span>${esc(p.category)}${p.is_cup_pool ? "" : ` · reorder at ${p.reorder_level}`}</span>
          </div>
        </div>
        <span class="badge badge-stock ${p.stock_status}">${
          p.is_cup_pool || p.uses_cup_stock
            ? `${p.quantity} cups`
            : p.is_ingredient
              ? `${p.quantity} ${esc(p.unit || "")}`.trim()
              : p.uses_recipe
                ? `${p.quantity} makeable`
                : `${p.quantity} left`
        }</span>
      </div>`
      )
      .join("");
  }

  const expiringLabel = document.getElementById("expiring-lots-label");
  const expiringList = document.getElementById("expiring-lots-list");
  const expiring = d.expiring_lots || [];
  if (expiringLabel) {
    const count = d.expiring_lots_count ?? expiring.length;
    expiringLabel.textContent = count ? `${count} within 7 days` : "None soon";
    expiringLabel.className = count
      ? "status-pill status-pill-warn"
      : "status-pill status-pill-ok";
  }
  if (expiringList) {
    if (!expiring.length) {
      expiringList.innerHTML = emptyState(
        UI_ICONS.check,
        "No expiry pressure",
        "No open lots expire in the next 7 days.",
        true
      );
    } else {
      expiringList.innerHTML = expiring
        .map((lot) => {
          const badgeClass = lot.expired ? "out" : "low";
          const badgeText = lot.expired ? "Expired" : lot.expiry_date;
          return `
        <div class="alert-row">
          <div class="alert-row-info">
            <div class="product-avatar product-avatar-sm">${esc(productInitials(lot.item_name || lot.pool))}</div>
            <div>
              <strong>${esc(lot.item_name || "Lot")}</strong>
              <span>${esc(lot.pool)} · ${fmtNum.format(lot.qty_remaining)} left · lot #${lot.id}</span>
            </div>
          </div>
          <span class="badge badge-stock ${badgeClass}">${esc(badgeText)}</span>
        </div>`;
        })
        .join("");
    }
  }

  const topList = document.getElementById("top-products-list");
  if (!d.top_products.filter((p) => p.units_sold > 0).length) {
    topList.innerHTML = emptyState(UI_ICONS.chart, "No sales yet", "Top sellers appear after your first sale.", true);
  } else {
    topList.innerHTML = d.top_products
      .map((p, i) => {
        const rankClass = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
        return `
        <div class="rank-item">
          <div class="rank-num ${rankClass}">${i + 1}</div>
          <div class="rank-info">
            <strong>${esc(p.name)}</strong>
            <span>${fmtNum.format(p.units_sold)} sold</span>
          </div>
          <div class="rank-revenue">${fmt.format(p.revenue)}</div>
        </div>`;
      })
      .join("");
  }

  const maxVal = Math.max(...d.categories.map((c) => c.value), 1);
  document.getElementById("category-breakdown").innerHTML = d.categories.length
    ? `<div class="category-bars">${d.categories
        .map(
          (c) => `
      <div class="category-bar-item">
        <div class="category-bar-header">
          <span class="category-bar-name">${esc(c.name)}</span>
          <span class="category-bar-meta">${fmt.format(c.value)} · ${c.total_qty} units</span>
        </div>
        <div class="category-bar-track">
          <div class="category-bar-fill" style="width:${(c.value / maxVal) * 100}%;--bar-color:${categoryAccent(c.name)}"></div>
        </div>
      </div>`
        )
        .join("")}</div>`
    : emptyState(UI_ICONS.box, "No products yet", "Add products to see category breakdown.", true);

  renderCategoryDonutChart(d.sales_by_category_today || []);
  const salesCategoryToday = document.getElementById("sales-category-today");
  if (salesCategoryToday) {
    const catData = d.sales_by_category_today || [];
    if (catData.length) {
      salesCategoryToday.innerHTML = renderCategoryBars(
        catData,
        "revenue",
        "No sales today",
        "Category sales appear after your first sale today."
      );
    } else {
      salesCategoryToday.innerHTML = emptyState(
        UI_ICONS.chart,
        "No sales today",
        "Category sales appear after your first sale today.",
        true
      );
    }
  }

  requestAnimationFrame(() => renderRevenueChart(d.daily_revenue_7d || [], d.today_date));

  renderDashboardSaleActivity(d);

  const recent = document.getElementById("recent-activity");
  if (!d.recent_transactions.length) {
    recent.innerHTML = emptyState(UI_ICONS.clock, "No activity yet", "Transactions will appear here.", true);
  } else {
    recent.innerHTML = `<div class="activity-feed">${d.recent_transactions
      .map(
        (t) => `
      <div class="activity-item">
        <div class="activity-dot ${t.type}"></div>
        <div class="activity-body">
          <strong>${esc(t.product_name)}</strong>
          <span>${formatDate(t.created_at)} · ${typeBadge(t.type)}${
            t.type === "sale"
              ? ` · ${esc(t.table_name || "—")} · ${esc(paymentMethodLabel(t.payment_method))} · ${esc(saleStatusLabel(t.status_label).text)}`
              : ""
          }</span>
        </div>
        <div class="activity-amount">
          ${t.type === "sale" ? fmt.format(t.total_amount) : `${t.quantity > 0 ? "+" : ""}${t.quantity} units`}
        </div>
      </div>`
      )
      .join("")}</div>`;
  }
}

// ── Products ───────────────────────────────────────────────────────────────

async function loadProducts() {
  const search = document.getElementById("product-search").value;
  const category = document.getElementById("product-category-filter").value;
  const lowStock = document.getElementById("low-stock-filter").checked;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (category) params.set("category", category);
  if (lowStock) params.set("low_stock", "1");

  showTableSkeleton("products-table-body", 8);

  try {
    state.products = await api(`/api/products?${params}`);
    renderProductsTable(state.products);
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderProductsTable(products) {
  const tbody = document.getElementById("products-table-body");
  const countEl = document.getElementById("products-count");
  if (countEl) {
    countEl.innerHTML = products.length
      ? `<strong>${fmtNum.format(products.length)}</strong> product${products.length !== 1 ? "s" : ""}`
      : "No products";
  }

  if (!products.length) {
    tbody.innerHTML = `<tr><td colspan="8">${emptyState(UI_ICONS.box, "No products found", "Try adjusting your filters or add your first item.")}</td></tr>`;
    return;
  }

  const role = state.currentUser?.role;
  const canManage = role === "admin" || role === "stock_manager";
  const canSell = role === "admin" || role === "stock_manager";

  const editBtn = (p) => `
          <button class="btn-icon" title="Edit" onclick="openEditProduct(${p.id})">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>`;
  const sellBtn = (p) => `
          <button class="btn-icon" title="Sell" onclick="quickSell(${p.id})">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
          </button>`;
  const deleteBtn = (p) => `
          <button class="btn-icon danger" title="Delete" onclick="openDeleteProduct(${p.id}, '${escAttr(p.name)}')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>`;

  const rowActions = (p) => {
    const buttons = [
      canManage ? editBtn(p) : "",
      canSell ? sellBtn(p) : "",
      canManage ? deleteBtn(p) : "",
    ].join("");
    return buttons
      ? `<div class="action-group">${buttons}</div>`
      : `<span class="text-muted">View only</span>`;
  };

  tbody.innerHTML = products
    .map(
      (p) => `
    <tr>
      <td>
        ${productCell(
          p.name,
          p.uses_recipe
            ? "Recipe product"
            : p.uses_cup_stock
              ? "Uses cup stock"
              : esc(p.category)
        )}
      </td>
      <td><span class="badge badge-category">${esc(p.category)}</span></td>
      <td>${fmt.format(p.price)}</td>
      <td>${p.cost_price != null ? fmt.format(p.cost_price) : "—"}</td>
      <td>${formatMargin(p)}</td>
      <td><strong>${
        p.uses_cup_stock
          ? `${fmtNum.format(p.quantity)} cups`
          : p.uses_recipe
            ? `${fmtNum.format(p.quantity)} makeable`
            : fmtNum.format(p.quantity)
      }</strong></td>
      <td><span class="badge badge-stock ${p.stock_status}">${stockLabel(p)}</span></td>
      <td>
        ${rowActions(p)}
      </td>
    </tr>`
    )
    .join("");
}

function categoryUsesCups(categoryName) {
  const category = state.categories.find(
    (c) => c.name.toLowerCase() === (categoryName || "").toLowerCase()
  );
  return category?.uses_cup_stock || false;
}

function stockLabel(p) {
  if (p.uses_cup_stock) {
    if (p.stock_status === "out") return "No cups";
    if (p.stock_status === "low") return "Low cups";
    return `${fmtNum.format(p.quantity)} cups`;
  }
  if (p.uses_recipe) {
    if (p.stock_status === "out") return "No ingredients";
    return `${fmtNum.format(p.quantity)} makeable`;
  }
  if (p.stock_status === "out") return "Out of stock";
  if (p.stock_status === "low") return "Low stock";
  return "In stock";
}

function availableStockLabel(p) {
  if (p.uses_cup_stock) return `${p.quantity} cups`;
  if (p.uses_recipe) return `${p.quantity} makeable`;
  return `${p.quantity} left`;
}

function productUsesRecipeChecked() {
  return !!document.getElementById("product-uses-recipe")?.checked;
}

function updateProductStockFields() {
  const categoryName = document.getElementById("product-category")?.value;
  const usesCups = categoryUsesCups(categoryName);
  const usesRecipe = productUsesRecipeChecked();
  const recipeCheckbox = document.getElementById("product-uses-recipe");
  const stockFields = document.getElementById("product-stock-fields");
  const cupHint = document.getElementById("product-cup-hint");
  const recipeFields = document.getElementById("product-recipe-fields");
  const costGroup = document.getElementById("product-cost-group");
  const recipeCostGroup = document.getElementById("product-recipe-cost-group");

  if (usesCups && usesRecipe && recipeCheckbox) {
    recipeCheckbox.checked = false;
    toast("Cup-stock categories cannot use recipes. Pick another category.", "error");
  }

  const recipeOn = productUsesRecipeChecked();
  if (recipeCheckbox) recipeCheckbox.disabled = usesCups;
  if (stockFields) stockFields.hidden = usesCups || recipeOn;
  if (cupHint) cupHint.hidden = !usesCups || recipeOn;
  if (recipeFields) recipeFields.hidden = !recipeOn;
  if (costGroup) costGroup.hidden = recipeOn;
  if (recipeCostGroup) recipeCostGroup.hidden = !recipeOn;
  if (recipeOn) updateRecipeCostPreview();
}

function ensureIngredientsLoaded(force = false) {
  if (!force && state.ingredients.length) {
    return Promise.resolve(state.ingredients);
  }
  return api("/api/ingredients").then((items) => {
    state.ingredients = items;
    return items;
  });
}

function renderRecipeLines() {
  const container = document.getElementById("recipe-lines");
  if (!container) return;
  const ingredients = state.ingredients || [];
  container.innerHTML = state.recipeDraft
    .map((line, index) => {
      const selected = ingredients.find((i) => i.id === Number(line.ingredient_id));
      const unit = selected?.unit || "—";
      return `
      <div class="recipe-line" data-index="${index}">
        <select data-recipe-field="ingredient_id" aria-label="Ingredient">
          <option value="">Choose...</option>
          ${ingredients
            .map(
              (ing) =>
                `<option value="${ing.id}" ${
                  Number(line.ingredient_id) === ing.id ? "selected" : ""
                }>${esc(ing.name)}</option>`
            )
            .join("")}
        </select>
        <input type="number" min="0.0001" step="any" data-recipe-field="qty_per_unit"
          value="${line.qty_per_unit != null && line.qty_per_unit !== "" ? escAttr(String(line.qty_per_unit)) : ""}"
          placeholder="Qty" aria-label="Quantity">
        <span class="recipe-line-unit">${esc(unit)}</span>
        <button type="button" class="btn-icon danger" data-remove-recipe-line="${index}" title="Remove">
          &times;
        </button>
      </div>`;
    })
    .join("");
  updateRecipeCostPreview();
}

function syncRecipeDraftFromDom() {
  const lines = [];
  document.querySelectorAll("#recipe-lines .recipe-line").forEach((row) => {
    const ingredientId = row.querySelector('[data-recipe-field="ingredient_id"]')?.value;
    const qty = row.querySelector('[data-recipe-field="qty_per_unit"]')?.value;
    lines.push({
      ingredient_id: ingredientId ? Number(ingredientId) : "",
      qty_per_unit: qty,
    });
  });
  state.recipeDraft = lines;
}

function addRecipeLine() {
  syncRecipeDraftFromDom();
  state.recipeDraft.push({ ingredient_id: "", qty_per_unit: "" });
  renderRecipeLines();
}

function removeRecipeLine(index) {
  syncRecipeDraftFromDom();
  state.recipeDraft.splice(index, 1);
  if (!state.recipeDraft.length) {
    state.recipeDraft.push({ ingredient_id: "", qty_per_unit: "" });
  }
  renderRecipeLines();
}

function collectRecipePayload() {
  syncRecipeDraftFromDom();
  const lines = [];
  for (const line of state.recipeDraft) {
    const ingredientId = Number(line.ingredient_id);
    const qty = parseFloat(line.qty_per_unit);
    if (!ingredientId && (line.qty_per_unit === "" || line.qty_per_unit == null)) {
      continue;
    }
    if (!ingredientId || !(qty > 0)) {
      return { error: "Each recipe line needs an ingredient and a quantity greater than zero" };
    }
    lines.push({ ingredient_id: ingredientId, qty_per_unit: qty });
  }
  if (!lines.length) {
    return { error: "Add at least one ingredient to the recipe" };
  }
  const ids = lines.map((l) => l.ingredient_id);
  if (new Set(ids).size !== ids.length) {
    return { error: "Duplicate ingredients in the recipe" };
  }
  return { lines };
}

function updateRecipeCostPreview() {
  const costEl = document.getElementById("product-recipe-cost");
  const marginEl = document.getElementById("product-recipe-margin-hint");
  if (!costEl) return;
  syncRecipeDraftFromDom();
  let total = 0;
  for (const line of state.recipeDraft) {
    const ing = state.ingredients.find((i) => i.id === Number(line.ingredient_id));
    const qty = parseFloat(line.qty_per_unit);
    if (!ing || !(qty > 0) || ing.cost_per_unit == null) continue;
    total += qty * Number(ing.cost_per_unit);
  }
  costEl.value = String(Math.round(total * 100) / 100);
  if (marginEl) {
    const sell = parseFloat(document.getElementById("product-price")?.value) || 0;
    if (sell > 0) {
      const margin = Math.round((sell - total) * 100) / 100;
      const pct = Math.round((margin / sell) * 1000) / 10;
      marginEl.textContent = `Margin ${fmt.format(margin)} (${pct}%)`;
    } else {
      marginEl.textContent = "Enter a sell price to see margin";
    }
  }
}

function openAddProduct() {
  Promise.all([loadCategories(), api("/api/products"), ensureIngredientsLoaded(true)])
    .then(([, products]) => {
      state.products = products;
      if (!state.categories.length) {
        toast("Add a category in Admin before creating products", "error");
        return;
      }

      document.getElementById("product-modal-title").textContent = "Add Product";
      document.getElementById("product-form").reset();
      document.getElementById("product-id").value = "";
      document.getElementById("product-quantity-label").textContent = "Initial Quantity";
      document.getElementById("product-reorder").value = "10";
      document.getElementById("product-cost-price").value = "0";
      document.getElementById("product-uses-recipe").checked = false;
      state.recipeDraft = [{ ingredient_id: "", qty_per_unit: "" }];
      populateCategorySelects();
      renderRecipeLines();
      updateProductStockFields();
      showModal("product-modal");
    })
    .catch((e) => toast(e.message, "error"));
}

async function openEditProduct(id) {
  try {
    const [p] = await Promise.all([
      api(`/api/products/${id}`),
      ensureIngredientsLoaded(true),
    ]);
    document.getElementById("product-modal-title").textContent = "Edit Product";
    document.getElementById("product-id").value = p.id;
    populateCategorySelects();
    document.getElementById("product-name").value = p.name;
    document.getElementById("product-category").value = p.category;
    document.getElementById("product-price").value = p.price;
    document.getElementById("product-cost-price").value = p.cost_price != null ? p.cost_price : 0;
    document.getElementById("product-quantity").value = p.uses_recipe ? 0 : p.quantity;
    document.getElementById("product-quantity-label").textContent = "Stock Quantity";
    document.getElementById("product-reorder").value = p.reorder_level;
    document.getElementById("product-description").value = p.description;
    document.getElementById("product-uses-recipe").checked = !!p.uses_recipe;
    state.recipeDraft =
      p.uses_recipe && Array.isArray(p.recipe) && p.recipe.length
        ? p.recipe.map((line) => ({
            ingredient_id: line.ingredient_id,
            qty_per_unit: line.qty_per_unit,
          }))
        : [{ ingredient_id: "", qty_per_unit: "" }];
    renderRecipeLines();
    updateProductStockFields();
    showModal("product-modal");
  } catch (e) {
    toast(e.message, "error");
  }
}

function openDeleteProduct(id, name) {
  state.deleteProductId = id;
  document.getElementById("delete-product-name").textContent = name;
  showModal("delete-modal");
}

async function saveProduct(e) {
  e.preventDefault();
  const id = document.getElementById("product-id").value;
  const name = document.getElementById("product-name").value.trim();
  const category = document.getElementById("product-category").value;
  const usesRecipe = productUsesRecipeChecked();

  if (!name) {
    toast("Enter a product name", "error");
    return;
  }
  if (!category) {
    toast("Choose a category", "error");
    return;
  }
  if (usesRecipe && categoryUsesCups(category)) {
    toast("Recipe products cannot use a cup-stock category", "error");
    return;
  }

  const payload = {
    name,
    category,
    price: parseFloat(document.getElementById("product-price").value),
    cost_price: parseFloat(document.getElementById("product-cost-price").value) || 0,
    reorder_level: parseInt(document.getElementById("product-reorder").value, 10) || 0,
    description: document.getElementById("product-description").value,
    quantity: parseInt(document.getElementById("product-quantity").value, 10) || 0,
    uses_recipe: usesRecipe,
  };

  if (usesRecipe) {
    const { lines, error } = collectRecipePayload();
    if (error) {
      toast(error, "error");
      return;
    }
    payload.recipe = lines;
    payload.quantity = 0;
    payload.reorder_level = 0;
    payload.cost_price = 0;
  } else {
    payload.recipe = [];
  }

  try {
    if (id) {
      await api(`/api/products/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("Product updated");
    } else {
      await api("/api/products", { method: "POST", body: JSON.stringify(payload) });
      toast("Product added");
    }
    hideModal("product-modal");
    loadProducts();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function confirmDelete() {
  try {
    await api(`/api/products/${state.deleteProductId}`, { method: "DELETE" });
    toast("Product deleted");
    hideModal("delete-modal");
    loadProducts();
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Sell / Cart ────────────────────────────────────────────────────────────

async function loadSellView() {
  try {
    if (isSeller()) {
      await refreshSellerShift();
    }
    const [products, cups, tables] = await Promise.all([
      api("/api/products"),
      api("/api/cups"),
      api("/api/tables"),
    ]);
    state.products = products;
    state.cupInventory = cups;
    state.serviceTables = tables;
    if (!state.categories.length) {
      state.categories = await api("/api/categories");
    }
    populateProductSelects();
    populateSellTableSelect();
    renderSellBrowse();
    syncCartWithStock();
    updateSellPreview();
    renderCart();
    updateSellShiftUi();
  } catch (e) {
    toast(e.message, "error");
  }
}

function updateSellShiftUi() {
  if (!isSeller()) return;

  const banner = document.getElementById("sell-shift-banner");
  const layout = document.getElementById("sell-layout");
  const checkoutBtn = document.getElementById("btn-complete-sale");
  const open = hasOpenShift();
  const joinable = getJoinableShift();
  const titleEl = document.getElementById("sell-shift-banner-title");
  const textEl = document.getElementById("sell-shift-banner-text");
  const btn = document.getElementById("btn-sell-start-shift");

  if (banner) banner.hidden = open;
  if (layout) layout.classList.toggle("sell-locked", !open);
  if (checkoutBtn) checkoutBtn.disabled = !open;

  if (!open && titleEl && textEl && btn) {
    if (joinable) {
      const lead = joinable.supervisor_name || "a teammate";
      titleEl.textContent = "Shift already open";
      textEl.textContent = `Join the open shift${lead ? ` with ${lead}` : ""} to start selling.`;
      btn.textContent = "Join Shift";
    } else {
      titleEl.textContent = "Shift not started";
      textEl.textContent = "Start a shift before you can sell. Floor supervisors close and reconcile.";
      btn.textContent = "Start Shift";
    }
  }
}

function togglePosMode() {
  state.posMode = !state.posMode;
  const sellView = document.getElementById("view-sell");
  const btn = document.getElementById("btn-pos-mode");
  const posBar = document.getElementById("pos-bar");
  const subtitle = document.getElementById("sell-subtitle");

  sellView?.classList.toggle("pos-mode", state.posMode);
  btn?.classList.toggle("active", state.posMode);
  if (posBar) posBar.hidden = !state.posMode;
  if (subtitle) {
    subtitle.textContent = state.posMode
      ? "Counter mode — larger tiles and keyboard shortcuts"
      : "Add items to the cart, then complete checkout in one step";
  }
  saveUIState();
}

function getSellCategories() {
  const categoryOrder = new Map(
    state.categories.map((c, i) => [c.name.toLowerCase(), { ...c, sort_order: c.sort_order ?? i }])
  );
  const namesInProducts = [...new Set(state.products.map((p) => p.category))];
  const ordered = state.categories
    .map((c) => c.name)
    .filter((name) => namesInProducts.some((n) => n.toLowerCase() === name.toLowerCase()));

  namesInProducts.forEach((name) => {
    if (!ordered.some((n) => n.toLowerCase() === name.toLowerCase())) {
      ordered.push(name);
    }
  });

  return ordered.map((name) => {
    const meta = categoryOrder.get(name.toLowerCase());
    return {
      name,
      sort_order: meta?.sort_order ?? 999,
      uses_cup_stock: meta?.uses_cup_stock ?? false,
      product_count: state.products.filter(
        (p) => p.category.toLowerCase() === name.toLowerCase()
      ).length,
    };
  });
}

function getSellProducts() {
  const products = [...state.products];
  if (state.sellCategory) {
    const selected = state.sellCategory.toLowerCase();
    return products.filter((p) => p.category.toLowerCase() === selected);
  }
  return products;
}

function selectSellCategory(categoryName) {
  state.sellCategory = categoryName || "";
  renderSellBrowse();
  populateProductSelects();
  updateSellPreview();
  saveUIState();
}

function backToSellCategories() {
  state.sellCategory = "";
  state.sellSearch = "";
  const searchInput = document.getElementById("sell-search");
  if (searchInput) searchInput.value = "";
  renderSellBrowse();
  populateProductSelects();
  updateSellPreview();
  saveUIState();
}

function renderSellBrowse() {
  const inCategory = Boolean(state.sellCategory);
  const categoryGrid = document.getElementById("sell-category-grid");
  const productGrid = document.getElementById("quick-pick-grid");
  const backBtn = document.getElementById("sell-back-btn");
  const title = document.getElementById("sell-pick-title");
  const hint = document.getElementById("sell-category-hint");
  const pickCard = document.querySelector(".sell-pick-card");
  const searchWrap = document.getElementById("sell-search-wrap");

  if (backBtn) backBtn.hidden = !inCategory;
  if (categoryGrid) categoryGrid.hidden = inCategory;
  if (productGrid) productGrid.hidden = !inCategory;
  if (pickCard) pickCard.classList.toggle("sell-pick-in-category", inCategory);
  if (searchWrap) searchWrap.hidden = !inCategory;

  if (title) {
    title.textContent = inCategory ? state.sellCategory : "Quick Pick";
  }

  if (hint) {
    if (inCategory) {
      const count = getSellProducts().length;
      hint.textContent = `${count} product${count !== 1 ? "s" : ""} · tap to add to cart`;
    } else {
      hint.textContent = "Choose a category to browse products";
    }
  }

  if (inCategory) {
    renderQuickPick();
  } else {
    renderSellCategories();
  }
}

function renderSellCategories() {
  const grid = document.getElementById("sell-category-grid");
  if (!grid) return;

  const categories = getSellCategories();

  if (!state.products.length) {
    grid.innerHTML = emptyState(UI_ICONS.box, "No products", "Add products to start selling.");
    return;
  }

  if (!categories.length) {
    grid.innerHTML = emptyState(UI_ICONS.box, "No categories", "Add products with categories to get started.");
    return;
  }

  grid.innerHTML = categories
    .map((category) => {
      const accent = categoryAccent(category.name);
      const inCart = cartQtyInCategory(category.name);
      const priceRange = getCategoryPriceRange(category.name);
      const inStock = state.products.filter(
        (p) => p.category.toLowerCase() === category.name.toLowerCase() && p.quantity > 0
      ).length;

      return `
    <button type="button" class="sell-category-card"
      style="--cat-accent: ${accent}"
      onclick="selectSellCategory('${escAttr(category.name)}')"
      role="listitem">
      <div class="sell-category-card-icon">${categoryIcon(category.name)}</div>
      <div class="sell-category-card-body">
        <strong>${esc(category.name)}</strong>
        <span class="sell-category-card-meta">
          ${category.product_count} item${category.product_count !== 1 ? "s" : ""}
          ${inStock < category.product_count ? ` · ${inStock} in stock` : ""}
        </span>
        ${priceRange ? `<span class="sell-category-card-price">${priceRange}</span>` : ""}
      </div>
      ${inCart ? `<span class="sell-category-cart-badge">${inCart} in cart</span>` : ""}
      <span class="sell-category-card-arrow" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </span>
    </button>`;
    })
    .join("");
}

function populateProductSelects() {
  const sellProducts = getSellProducts().filter((p) => p.quantity > 0);
  const stockProducts = state.products.filter((p) => !p.uses_cup_stock && !p.uses_recipe);

  const sellSelect = document.getElementById("sell-product");
  if (sellSelect) {
    sellSelect.innerHTML =
      '<option value="">Choose a product...</option>' +
      sellProducts
        .map((p) => {
          let stockText = `${p.quantity} in stock`;
          if (p.uses_cup_stock) stockText = `${p.quantity} cups`;
          else if (p.uses_recipe) stockText = `${p.quantity} makeable`;
          return `<option value="${p.id}">${esc(p.name)} — ${stockText}</option>`;
        })
        .join("");
  }

  ["restock-product", "adjust-product"].forEach((id) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML =
      '<option value="">Choose a product...</option>' +
      stockProducts
        .map((p) => `<option value="${p.id}">${esc(p.name)} (${p.quantity} units)</option>`)
        .join("");
  });

  populateIngredientRestockSelect();
}

function populateIngredientRestockSelect() {
  const sel = document.getElementById("ingredient-restock-select");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML =
    '<option value="">Choose an ingredient...</option>' +
    (state.ingredients || [])
      .map(
        (ing) =>
          `<option value="${ing.id}">${esc(ing.name)} (${fmtNum.format(ing.quantity)} ${esc(ing.unit)})</option>`
      )
      .join("");
  if (current) sel.value = current;
}

function initPosShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (!document.getElementById("view-sell")?.classList.contains("active")) return;

    if (e.key === "Escape" && state.cart.length) {
      e.preventDefault();
      clearCart();
      return;
    }

    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      if (document.activeElement?.tagName === "TEXTAREA") return;
      e.preventDefault();
      if (state.cart.length) completeCheckout();
    }
  });
}

function getCartCupDemand(excludeProductId = null) {
  return state.cart.reduce((total, item) => {
    if (excludeProductId && item.product_id === excludeProductId) return total;
    const product = state.products.find((p) => p.id === item.product_id);
    return total + (product?.uses_cup_stock ? item.quantity : 0);
  }, 0);
}

function getAvailableUnits(product, excludeProductId = null) {
  if (!product) return 0;
  if (product.uses_cup_stock) {
    const cupsInCart = getCartCupDemand(excludeProductId);
    return Math.max(product.quantity - cupsInCart, 0);
  }
  const inCart = state.cart.find((c) => c.product_id === product.id);
  return Math.max(product.quantity - (inCart?.quantity || 0), 0);
}

function syncCartWithStock() {
  state.cart = state.cart.filter((item) => {
    const product = state.products.find((p) => p.id === item.product_id);
    if (!product || product.quantity <= 0) return false;
    const available = getAvailableUnits(product, item.product_id) + item.quantity;
    if (available <= 0) return false;
    if (item.quantity > available) item.quantity = available;
    item.maxStock = available;
    item.price = product.price;
    item.name = product.name;
    item.category = product.category;
    item.uses_cup_stock = product.uses_cup_stock;
    return true;
  });
}

function cartQtyInCart(productId) {
  const item = state.cart.find((c) => c.product_id === productId);
  return item ? item.quantity : 0;
}

function renderQuickPick() {
  const grid = document.getElementById("quick-pick-grid");
  let products = getSellProducts();

  if (!state.products.length) {
    grid.innerHTML = emptyState(UI_ICONS.box, "No products", "Add products to start selling.");
    return;
  }

  if (!products.length) {
    grid.innerHTML = emptyState(
      UI_ICONS.box,
      "No products in this category",
      "Try another category or add products here."
    );
    return;
  }

  const query = (state.sellSearch || "").trim().toLowerCase();
  if (query) {
    products = products.filter((p) => p.name.toLowerCase().includes(query));
  }

  if (!products.length) {
    grid.innerHTML = `
      <div class="sell-no-results">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <strong>No results for "${esc(state.sellSearch)}"</strong>
        <p>Try a different name or clear the search.</p>
      </div>`;
    return;
  }

  grid.innerHTML = products
    .map((p) => {
      const inCart = cartQtyInCart(p.id);
      const available = getAvailableUnits(p);
      const disabled = p.quantity <= 0 || available <= 0;
      const accent = categoryAccent(p.category);
      const stockClass =
        available <= 0 ? "stock-out" : available <= (p.reorder_level || 5) ? "stock-low" : "stock-ok";
      return `
    <button type="button" class="quick-pick-item ${disabled ? "out-of-stock" : ""} ${inCart ? "in-cart" : ""}"
      style="--qp-accent: ${accent}"
      ${disabled ? "disabled" : `onclick="addToCart(${p.id}, 1)"`}>
      <div class="qp-item-body">
        <div class="qp-item-top">
          <div class="qp-avatar">${esc(productInitials(p.name))}</div>
          ${inCart ? `<span class="qp-cart-badge">${inCart}</span>` : ""}
        </div>
        <strong>${esc(p.name)}</strong>
        <span class="qp-stock ${stockClass}">${availableStockLabel({ ...p, quantity: available })}</span>
      </div>
      <div class="qp-item-footer">
        <div class="qp-price">${fmt.format(p.price)}</div>
      </div>
    </button>`;
    })
    .join("");
}

function updateSellPreview() {
  const id = parseInt(document.getElementById("sell-product").value, 10);
  const preview = document.getElementById("sell-preview");
  const product = state.products.find((p) => p.id === id);

  if (!product) {
    preview.hidden = true;
    return;
  }

  preview.hidden = false;
  document.getElementById("preview-price").textContent = fmt.format(product.price);
  const available = getAvailableUnits(product);
  const unitWord = product.uses_cup_stock
    ? "cups"
    : product.uses_recipe
      ? "makeable"
      : "units";
  document.getElementById("preview-stock").textContent =
    available > 0
      ? `${available} ${unitWord} available`
      : "All in cart";
  document.getElementById("preview-category").textContent = product.category;

  const qtyInput = document.getElementById("sell-quantity");
  qtyInput.max = Math.max(available, 1);
  if (parseInt(qtyInput.value, 10) > available) {
    qtyInput.value = Math.max(available, 1);
  }
}

function adjustQty(delta) {
  const input = document.getElementById("sell-quantity");
  const max = parseInt(input.max, 10) || 9999;
  let val = (parseInt(input.value, 10) || 1) + delta;
  val = Math.max(1, Math.min(val, max));
  input.value = val;
}

function addToCart(productId, qty = null) {
  const product = state.products.find((p) => p.id === productId);
  if (!product || product.quantity <= 0) {
    toast(
      product?.uses_cup_stock
        ? "No cups left in stock"
        : product?.uses_recipe
          ? "Not enough ingredients to make this"
          : "Product out of stock",
      "error"
    );
    return;
  }

  const addQty = qty ?? (parseInt(document.getElementById("sell-quantity").value, 10) || 1);
  const existing = state.cart.find((c) => c.product_id === productId);
  const currentInCart = existing ? existing.quantity : 0;
  const available = getAvailableUnits(product);
  const unitLabel = product.uses_cup_stock
    ? "cup(s)"
    : product.uses_recipe
      ? "serving(s)"
      : "unit(s)";

  if (addQty > available) {
    toast(
      available > 0
        ? `Only ${available} more ${unitLabel} available for ${product.name}`
        : product.uses_cup_stock
          ? "No cups left for this sale"
          : `${product.name} is fully in the cart`,
      "error"
    );
    return;
  }

  if (existing) {
    existing.quantity += addQty;
    existing.uses_cup_stock = product.uses_cup_stock;
    existing.uses_recipe = product.uses_recipe;
  } else {
    state.cart.push({
      product_id: productId,
      name: product.name,
      category: product.category,
      price: product.price,
      quantity: addQty,
      maxStock: available + addQty,
      uses_recipe: !!product.uses_recipe,
      uses_cup_stock: product.uses_cup_stock,
    });
  }

  renderCart();
  renderSellBrowse();
  updateSellPreview();
  toast(`Added ${product.name}`);
  saveUIState();
}

function updateCartItemQty(productId, quantity) {
  const item = state.cart.find((c) => c.product_id === productId);
  const currentQty = item ? item.quantity : 0;

  if (quantity < 1) {
    requireCartRemovalAuth(
      () => applyRemoveFromCart(productId),
      "Removing items from the cart requires an admin password."
    );
    return;
  }

  if (item && quantity < currentQty) {
    requireCartRemovalAuth(
      () => applyUpdateCartItemQty(productId, quantity),
      "Reducing item quantities requires an admin password."
    );
    return;
  }

  applyUpdateCartItemQty(productId, quantity);
}

function applyUpdateCartItemQty(productId, quantity) {
  const item = state.cart.find((c) => c.product_id === productId);
  const product = state.products.find((p) => p.id === productId);
  if (!item || !product) return;

  quantity = Math.min(quantity, product.quantity);
  item.quantity = quantity;
  renderCart();
  renderSellBrowse();
  updateSellPreview();
  saveUIState();
}

function removeFromCart(productId) {
  requireCartRemovalAuth(
    () => applyRemoveFromCart(productId),
    "Removing items from the cart requires an admin password."
  );
}

function applyRemoveFromCart(productId) {
  state.cart = state.cart.filter((c) => c.product_id !== productId);
  renderCart();
  renderSellBrowse();
  updateSellPreview();
  saveUIState();
}

function clearCart() {
  if (!state.cart.length) {
    applyClearCart();
    return;
  }
  requireCartRemovalAuth(
    () => applyClearCart(),
    "Clearing the cart requires an admin password."
  );
}

function applyClearCart() {
  state.cart = [];
  clearPaymentMethod();
  document.getElementById("sell-notes").value = "";
  document.getElementById("add-to-cart-form").reset();
  document.getElementById("sell-quantity").value = "1";
  document.getElementById("sell-preview").hidden = true;
  renderCart();
  renderSellBrowse();
  saveUIState();
}

// Sellers must confirm an admin password before removing/reducing cart items.
function requireCartRemovalAuth(action, message) {
  if (typeof action !== "function") return;
  pendingCartRemoval = action;
  openCartRemoveModal(message);
}

function openCartRemoveModal(message) {
  const label = document.getElementById("cart-remove-label");
  if (label && message) label.textContent = message;
  const pwd = document.getElementById("cart-remove-password");
  if (pwd) pwd.value = "";
  showModal("cart-remove-modal");
  pwd?.focus();
}

function cancelCartRemoval() {
  pendingCartRemoval = null;
  // Re-render so any optimistic quantity-input change is reverted to state.
  renderCart();
}

async function submitCartRemove(e) {
  e.preventDefault();
  const action = pendingCartRemoval;
  const password = document.getElementById("cart-remove-password")?.value || "";

  if (!action) {
    hideModal("cart-remove-modal");
    return;
  }

  try {
    await api("/api/auth/verify-admin", {
      method: "POST",
      body: JSON.stringify({ admin_password: password }),
    });
    hideModal("cart-remove-modal");
    pendingCartRemoval = null;
    action();
  } catch (err) {
    toast(err.message, "error");
  }
}

function getCartTotal() {
  return state.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

function renderCart() {
  const empty = document.getElementById("cart-empty");
  const list = document.getElementById("cart-items");
  const footer = document.getElementById("cart-footer");
  const countEl = document.getElementById("cart-item-count");
  const totalUnits = state.cart.reduce((sum, item) => sum + item.quantity, 0);

  if (!state.cart.length) {
    empty.hidden = false;
    list.hidden = true;
    footer.hidden = true;
    countEl.textContent = "0 items";
    return;
  }

  empty.hidden = true;
  list.hidden = false;
  footer.hidden = false;
  countEl.textContent = `${totalUnits} item${totalUnits !== 1 ? "s" : ""}`;
  document.getElementById("cart-total").textContent = fmt.format(getCartTotal());

  list.innerHTML = state.cart
    .map(
      (item) => `
    <div class="cart-item">
      <div class="cart-item-info">
        <strong>${esc(item.name)}</strong>
        <span>${esc(item.category)} · ${fmt.format(item.price)} each</span>
      </div>
      <div class="cart-item-actions">
        <div class="qty-input qty-input-sm">
          <button type="button" class="qty-btn" onclick="updateCartItemQty(${item.product_id}, ${item.quantity - 1})">−</button>
          <input type="number" value="${item.quantity}" min="1" max="${item.maxStock}"
            onchange="updateCartItemQty(${item.product_id}, parseInt(this.value, 10) || 1)">
          <button type="button" class="qty-btn" onclick="updateCartItemQty(${item.product_id}, ${item.quantity + 1})">+</button>
        </div>
        <div class="cart-line-total">${fmt.format(item.price * item.quantity)}</div>
        <button type="button" class="btn-icon danger" title="Remove" onclick="removeFromCart(${item.product_id})">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>`
    )
    .join("");
}

function submitAddToCart(e) {
  e.preventDefault();
  const productId = parseInt(document.getElementById("sell-product").value, 10);
  if (!productId) {
    toast("Please select a product", "error");
    return;
  }
  addToCart(productId);
  document.getElementById("sell-product").value = "";
  document.getElementById("sell-quantity").value = "1";
  document.getElementById("sell-preview").hidden = true;
}

async function completeCheckout() {
  if (isSeller() && !hasOpenShift()) {
    toast("Start or join a shift before selling.", "error");
    switchView("reconcile");
    return;
  }

  if (!state.cart.length) {
    toast("Cart is empty", "error");
    return;
  }

  if (!state.paymentMethod) {
    toast("Select a payment method: MoMo, Cash, Visa, or Credit", "error");
    return;
  }

  if (!state.selectedTableId) {
    toast("Select a table before selling.", "error");
    document.getElementById("sell-table")?.focus();
    return;
  }

  const notes = document.getElementById("sell-notes").value.trim();
  if (state.paymentMethod === "credit" && !notes) {
    toast("Add the customer name in Notes for credit sales.", "error");
    document.getElementById("sell-notes")?.focus();
    return;
  }

  const btn = document.getElementById("btn-complete-sale");
  btn.disabled = true;

  try {
    const result = await api("/api/sales/checkout", {
      method: "POST",
      body: JSON.stringify({
        items: state.cart.map((c) => ({
          product_id: c.product_id,
          quantity: c.quantity,
        })),
        notes,
        payment_method: state.paymentMethod,
        table_id: state.selectedTableId,
      }),
    });

    const paymentLabel = result.payment_label || paymentMethodLabel(result.payment_method);
    const isCredit = result.payment_method === "credit" || result.payment_status === "credit";
    const tableName = result.table_name || "";
    toast(
      isCredit
        ? `Credit recorded — ${fmt.format(result.total_amount)}${tableName ? ` · ${tableName}` : ""} · ${result.checkout_ref}`
        : `Payment received — ${fmt.format(result.total_amount)} · ${paymentLabel}${tableName ? ` · ${tableName}` : ""} · ${result.checkout_ref}`,
      "success"
    );

    applyClearCart();
    await loadSellView();
    if (!isSeller()) loadDashboard();

    showInvoice({
      checkout_ref: result.checkout_ref,
      created_at: new Date().toISOString(),
      payment_method: result.payment_method,
      payment_label: paymentLabel,
      table_name: result.table_name || "",
      seller_name: state.currentUser?.display_name || state.currentUser?.username || "—",
      notes: (notes || "").trim() || null,
      total_amount: result.total_amount,
      total_units: result.total_units,
      is_voided: false,
      items: (result.items || []).map((item) => ({
        product_name: item.product?.name || "Item",
        category: item.product?.category || "",
        quantity: item.quantity_sold,
        unit_price: item.unit_price,
        total_amount: item.total_amount,
      })),
    });
  } catch (err) {
    toast(err.message, "error");
    await loadSellView();
  } finally {
    btn.disabled = false;
  }
}

function invoiceFromHistoryGroup(group) {
  return {
    checkout_ref: group.checkout_ref,
    created_at: group.created_at,
    payment_method: group.payment_method,
    payment_label: paymentMethodLabel(group.payment_method),
    table_name: group.table_name || "",
    seller_name: group.seller_name || state.currentUser?.display_name || "—",
    notes: group.notes || null,
    total_amount: group.total,
    total_units: group.units,
    is_voided: !!group.is_voided,
    items: (group.items || []).map((item) => ({
      product_name: item.product_name,
      category: item.category || "",
      quantity: item.quantity,
      unit_price: item.unit_price,
      total_amount: item.total_amount,
    })),
  };
}

function showInvoice(invoice) {
  const meta = document.getElementById("invoice-meta");
  const lines = document.getElementById("invoice-lines");
  const totals = document.getElementById("invoice-totals");
  const notesEl = document.getElementById("invoice-notes");
  const voidBanner = document.getElementById("invoice-voided-banner");
  if (!meta || !lines || !totals) return;

  const seller = invoice.seller_name || "—";
  const payment = invoice.payment_label || paymentMethodLabel(invoice.payment_method);
  const when = invoice.created_at ? formatDate(invoice.created_at) : formatDate(new Date().toISOString());

  if (voidBanner) voidBanner.hidden = !invoice.is_voided;

  meta.innerHTML = `
    <div>
      <dt>Invoice #</dt>
      <dd>${esc(invoice.checkout_ref || "—")}</dd>
    </div>
    <div>
      <dt>Date</dt>
      <dd>${esc(when)}</dd>
    </div>
    <div>
      <dt>Table</dt>
      <dd>${esc(invoice.table_name || "—")}</dd>
    </div>
    <div>
      <dt>Seller</dt>
      <dd>${esc(seller)}</dd>
    </div>
    <div>
      <dt>Payment</dt>
      <dd>${esc(payment)}</dd>
    </div>
  `;

  lines.innerHTML = (invoice.items || [])
    .map(
      (item) => `
    <tr>
      <td>
        <span class="item-name">${esc(item.product_name)}</span>
        ${item.category ? `<span class="item-cat">${esc(item.category)}</span>` : ""}
      </td>
      <td class="num">${fmtNum.format(item.quantity)}</td>
      <td class="num">${fmt.format(item.unit_price)}</td>
      <td class="num">${fmt.format(item.total_amount)}</td>
    </tr>`
    )
    .join("");

  totals.innerHTML = `
    <div class="invoice-totals-row">
      <span>Items</span>
      <span>${fmtNum.format(invoice.total_units || 0)}</span>
    </div>
    <div class="invoice-totals-row grand">
      <span>Total</span>
      <span>${fmt.format(invoice.total_amount || 0)}</span>
    </div>
  `;

  if (invoice.notes && notesEl) {
    notesEl.hidden = false;
    notesEl.innerHTML = `<strong>Notes:</strong> ${esc(invoice.notes)}`;
  } else if (notesEl) {
    notesEl.hidden = true;
    notesEl.textContent = "";
  }

  showModal("invoice-modal");
}

function printInvoice() {
  const area = document.getElementById("invoice-print-area");
  if (!area) return;

  const existing = document.getElementById("invoice-print-root");
  if (existing) existing.remove();

  const logoSrc = area.querySelector(".invoice-logo")?.getAttribute("src") || "/static/img/logo.png";
  const clone = area.cloneNode(true);
  const logo = clone.querySelector(".invoice-logo");
  if (logo) {
    logo.setAttribute("src", new URL(logoSrc, window.location.origin).href);
  }

  const root = document.createElement("div");
  root.id = "invoice-print-root";
  root.innerHTML = `
    <style>
      #invoice-print-root { display: none; }
      @media print {
        @page {
          size: A5 portrait;
          margin: 8mm;
        }
        html, body {
          margin: 0 !important;
          padding: 0 !important;
          background: #fff !important;
          height: auto !important;
          overflow: visible !important;
        }
        body > *:not(#invoice-print-root) {
          display: none !important;
        }
        #invoice-print-root {
          display: block !important;
          width: 100%;
          max-width: 118mm;
          margin: 0 auto;
          color: #2c1810;
          font-family: "Plus Jakarta Sans", system-ui, sans-serif;
          font-size: 10pt;
          line-height: 1.35;
        }
        #invoice-print-root .invoice {
          border: 1px solid #e0d5c8;
          border-radius: 6px;
          overflow: hidden;
        }
        #invoice-print-root .invoice-brand {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          gap: 6px;
          margin: 0;
          padding: 12px 12px 10px;
          background: #faf6f1;
          border-bottom: 1px solid #e8ddd0;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        #invoice-print-root .invoice-logo {
          width: 72px;
          height: auto;
          max-height: 56px;
          object-fit: contain;
          display: block;
        }
        #invoice-print-root .invoice-brand-text h2 {
          margin: 0;
          font-family: Fraunces, Georgia, serif;
          font-size: 13pt;
          font-weight: 600;
          color: #2c1810;
        }
        #invoice-print-root .invoice-brand-text p {
          margin: 2px 0 0;
          font-size: 7.5pt;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #7a6a5e;
          font-weight: 600;
        }
        #invoice-print-root .invoice-body {
          padding: 10px 12px 12px;
        }
        #invoice-print-root .invoice-meta {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px 10px;
          margin: 0 0 10px;
          padding: 7px 8px;
          background: #faf6f1;
          border: 1px solid #e8ddd0;
          border-radius: 4px;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        #invoice-print-root .invoice-meta dt {
          margin: 0;
          font-size: 7pt;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #7a6a5e;
          font-weight: 600;
        }
        #invoice-print-root .invoice-meta dd {
          margin: 1px 0 0;
          font-size: 9pt;
          font-weight: 600;
          word-break: break-word;
        }
        #invoice-print-root .invoice-voided-banner {
          margin: 0 0 8px;
          padding: 4px 6px;
          border: 1px solid #c45c4a;
          color: #c45c4a;
          font-size: 8.5pt;
          font-weight: 600;
          text-align: center;
          border-radius: 4px;
        }
        #invoice-print-root .invoice-table {
          width: 100%;
          border-collapse: collapse;
          margin: 0 0 10px;
          font-size: 9pt;
        }
        #invoice-print-root .invoice-table th {
          text-align: left;
          font-size: 7pt;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #7a6a5e;
          padding: 3px 2px;
          border-bottom: 1.5px solid #e8ddd0;
        }
        #invoice-print-root .invoice-table td {
          padding: 5px 2px;
          border-bottom: 1px solid #f0e8dc;
          vertical-align: top;
        }
        #invoice-print-root .invoice-table tbody tr:last-child td {
          border-bottom: none;
        }
        #invoice-print-root .invoice-table .num {
          text-align: right;
          white-space: nowrap;
        }
        #invoice-print-root .item-name { font-weight: 600; }
        #invoice-print-root .item-cat {
          display: block;
          font-size: 7.5pt;
          font-weight: 500;
          color: #7a6a5e;
        }
        #invoice-print-root .invoice-totals {
          background: #f5e6d3;
          border: 1px solid #e8ddd0;
          border-radius: 4px;
          padding: 7px 9px;
          margin: 0 0 8px;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        #invoice-print-root .invoice-totals-row {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          font-size: 9pt;
          padding: 1px 0;
          color: #5d4037;
        }
        #invoice-print-root .invoice-totals-row.grand {
          margin-top: 4px;
          padding-top: 5px;
          border-top: 1.5px solid #c4a574;
          font-family: Fraunces, Georgia, serif;
          font-size: 12pt;
          font-weight: 600;
          color: #2c1810;
        }
        #invoice-print-root .invoice-notes {
          margin: 0 0 8px;
          padding: 5px 7px;
          border-left: 3px solid #c4a574;
          background: #faf6f1;
          font-size: 8pt;
          color: #5d4037;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        #invoice-print-root .invoice-footer {
          margin: 0;
          padding-top: 7px;
          border-top: 1px dashed #e8ddd0;
          text-align: center;
          font-size: 8pt;
          color: #a89888;
        }
      }
    </style>
  `;
  root.appendChild(clone);
  document.body.appendChild(root);

  const cleanup = () => {
    root.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);

  // Ensure logo is loaded before printing
  const printLogo = root.querySelector(".invoice-logo");
  const doPrint = () => {
    window.print();
    setTimeout(cleanup, 1000);
  };
  if (printLogo && !printLogo.complete) {
    printLogo.onload = doPrint;
    printLogo.onerror = doPrint;
  } else {
    doPrint();
  }
}

window.showInvoiceFromHistory = function showInvoiceFromHistory(checkoutRef) {
  const group = state.historySaleGroups?.get(checkoutRef);
  if (!group) {
    toast("Invoice not found for this sale", "error");
    return;
  }
  showInvoice(invoiceFromHistoryGroup(group));
};

function quickSell(id) {
  const product = state.products.find((p) => p.id === id);
  if (product) {
    state.sellCategory = product.category;
    state.keepSellCategory = true;
  }
  switchView("sell");
  setTimeout(() => addToCart(id, 1), 100);
}

// ── Seller shift management ─────────────────────────────────────────────────

const SHIFT_HERO_ICONS = {
  idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  open: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>`,
  closed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
};

let shiftTimerInterval = null;
let shiftUiPhase = "sell"; // "sell" | "close" while shift is open
let pendingShiftUiPhase = null; // set before switchView("reconcile") to open on close form

const CASH_DENOMS = [5000, 2000, 1000, 500, 100, 50];

function readCashNotesFromForm() {
  const notes = {};
  for (const denom of CASH_DENOMS) {
    const input = document.getElementById(`cash-note-${denom}`);
    notes[String(denom)] = parseInt(input?.value, 10) || 0;
  }
  return notes;
}

function updateCashNotesTotal() {
  const notes = readCashNotesFromForm();
  let total = 0;
  for (const denom of CASH_DENOMS) {
    const count = notes[String(denom)];
    total += denom * count;
    const subEl = document.getElementById(`cash-note-sub-${denom}`);
    if (subEl) subEl.textContent = fmt.format(denom * count);
  }
  const totalEl = document.getElementById("cash-notes-total");
  if (totalEl) totalEl.textContent = fmt.format(total);
  const dockEl = document.getElementById("cash-notes-total-dock");
  if (dockEl) dockEl.textContent = fmt.format(total);
}

function clearCashNoteInputs() {
  for (const denom of CASH_DENOMS) {
    const input = document.getElementById(`cash-note-${denom}`);
    if (input) input.value = "";
  }
  for (const id of ["counted-momo", "counted-visa"]) {
    const input = document.getElementById(id);
    if (input) input.value = "";
  }
  updateCashNotesTotal();
}

function readCountedPaymentAmount(id) {
  const input = document.getElementById(id);
  const value = parseFloat(input?.value);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function paymentVarianceStatus(variance) {
  if (!variance || variance === 0) return { text: "Balanced", cls: "balanced" };
  if (variance > 0) return { text: "Over", cls: "over" };
  return { text: "Short", cls: "short" };
}

function renderPaymentReconcileCards(shift) {
  const rows = [
    {
      label: "Cash",
      counted: shift.counted_cash ?? shift.counted_total ?? 0,
      expected: shift.expected_cash ?? shift.cash_sales ?? 0,
      variance: shift.variance ?? 0,
      cls: "cash",
    },
    {
      label: "MoMo",
      counted: shift.counted_momo ?? 0,
      expected: shift.expected_momo ?? shift.momo_sales ?? 0,
      variance: shift.momo_variance ?? 0,
      cls: "momo",
    },
    {
      label: "Visa",
      counted: shift.counted_visa ?? 0,
      expected: shift.expected_visa ?? shift.visa_sales ?? 0,
      variance: shift.visa_variance ?? 0,
      cls: "visa",
    },
  ];

  return `
    <div class="payment-reconcile-grid">
      ${rows
        .map((row) => {
          const status = paymentVarianceStatus(row.variance);
          const varianceLine =
            row.variance === 0
              ? ""
              : `<div class="payment-reconcile-var ${status.cls}"><span>Variance</span><strong>${row.variance > 0 ? "+" : "−"}${fmt.format(Math.abs(row.variance))}</strong></div>`;
          return `
            <div class="payment-reconcile-card ${status.cls}">
              <div class="payment-reconcile-head">
                <span class="shift-payment-dot ${row.cls}"></span>
                <strong>${row.label}</strong>
                <span class="payment-reconcile-chip ${status.cls}">${status.text}</span>
              </div>
              <div class="payment-reconcile-lines">
                <div><span>Counted</span><strong>${fmt.format(row.counted)}</strong></div>
                <div><span>Recorded</span><strong>${fmt.format(row.expected)}</strong></div>
                ${varianceLine}
              </div>
            </div>`;
        })
        .join("")}
    </div>`;
}

function renderCashNotesBreakdown(cashNotes) {
  if (!cashNotes) return "";
  return CASH_DENOMS.map((denom) => {
    const count = cashNotes[String(denom)] || 0;
    if (!count) return "";
    return `<div class="cash-note-line"><span>${fmtNum.format(denom)} × ${count}</span><strong>${fmt.format(denom * count)}</strong></div>`;
  })
    .filter(Boolean)
    .join("");
}

function setShiftUiPhase(phase) {
  if (phase === "close" && !canCloseShift()) {
    toast("Only a floor supervisor can close and reconcile.", "error");
    phase = "sell";
  }
  shiftUiPhase = phase === "close" ? "close" : "sell";
  const data = state.sellerShift;
  if (data?.has_open_shift && data.shift) {
    const startedAt = formatDate(data.shift.opened_at);
    const descEl = document.getElementById("shift-hero-desc");
    if (descEl) {
      const lead = data.shift.supervisor_name;
      if (shiftUiPhase === "close") {
        descEl.textContent = `Started ${startedAt}. Enter what was collected for cash, MoMo, and Visa for the whole team.`;
      } else if (isShiftSupervisor()) {
        descEl.textContent = `Started ${startedAt}. You are a floor supervisor — teammates can join and sell; you can close.`;
      } else {
        descEl.textContent = `Started ${startedAt}${lead ? ` · with ${lead}` : ""}. Sell as usual — a floor supervisor will reconcile.`;
      }
    }
  }
  renderShiftOpenPhase();
}

function renderShiftTeamList(shift) {
  const listEl = document.getElementById("shift-team-list");
  if (!listEl) return;
  const members = (shift?.active_members || shift?.members || []).filter((m) => m.active !== false);
  if (!members.length) {
    listEl.hidden = true;
    listEl.innerHTML = "";
    return;
  }
  listEl.hidden = false;
  listEl.innerHTML = `
    <div class="shift-team-head">On this shift</div>
    <ul class="shift-team-people">
      ${members
        .map((m) => {
          const role =
            m.role_on_shift === "supervisor" ? "Supervisor" : "Seller";
          return `<li>
            <span class="shift-team-name">${esc(m.display_name)}</span>
            <span class="shift-team-role ${m.role_on_shift}">${role}</span>
          </li>`;
        })
        .join("")}
    </ul>
  `;
}

function renderShiftOpenPhase() {
  const sellHint = document.getElementById("shift-sell-hint");
  const closeCard = document.getElementById("shift-close-card");
  const heroActions = document.getElementById("shift-hero-actions");
  const panels = document.getElementById("shift-panels");
  const subtitle = document.getElementById("reconcile-subtitle");
  const view = document.getElementById("view-reconcile");
  const closeBtn = document.getElementById("btn-show-close");
  const memberWait = document.getElementById("shift-member-wait");
  const hintText = document.getElementById("shift-sell-hint-text");
  const closing = shiftUiPhase === "close" && canCloseShift();
  const supervisor = canCloseShift();

  if (sellHint) sellHint.hidden = closing;
  if (closeCard) closeCard.hidden = !closing;
  if (heroActions) heroActions.hidden = closing;
  if (closeBtn) closeBtn.hidden = !supervisor;
  if (memberWait) memberWait.hidden = supervisor;
  if (hintText) {
    hintText.textContent = supervisor
      ? "Record sales on the Sell screen. When everyone is done, close and reconcile for the whole team."
      : "Record sales on the Sell screen. The shift supervisor will close and reconcile cash, MoMo, and Visa.";
  }
  if (panels) {
    panels.classList.remove("is-idle", "is-active", "is-closed", "is-selling", "is-closing");
    panels.classList.add(closing ? "is-closing" : "is-selling");
  }
  if (view) view.classList.toggle("is-closing-shift", closing);
  if (subtitle) {
    if (closing) {
      subtitle.textContent = "Enter cash, MoMo, and Visa totals for the whole team — then tap Close & reconcile.";
    } else if (supervisor) {
      subtitle.textContent = "You are a floor supervisor. Teammates can join and sell; you can balance and close.";
    } else {
      subtitle.textContent = "You joined this shift as a seller. Sell as usual — a floor supervisor will close and reconcile.";
    }
  }
  renderShiftTeamList(state.sellerShift?.shift);
  updateShiftSteps(closing ? "close" : "sell");
}

async function refreshSellerShift() {
  if (!isSeller()) return null;
  state.sellerShift = await api("/api/seller/shift");
  return state.sellerShift;
}

function reconcileStatusLabel(status) {
  if (status === "balanced") return { text: "Balanced", cls: "balanced", icon: UI_ICONS.check };
  if (status === "over") return { text: "Over", cls: "over", icon: UI_ICONS.alert };
  return { text: "Short", cls: "short", icon: UI_ICONS.alert };
}

function formatShiftRange(shift) {
  const opened = formatDate(shift.opened_at);
  if (!shift.closed_at) return `Started ${opened}`;
  return `${opened} → ${formatDate(shift.closed_at)}`;
}

function formatShiftDuration(openedAt, long = false) {
  const start = new Date(openedAt.includes("T") ? openedAt : openedAt.replace(" ", "T"));
  if (Number.isNaN(start.getTime())) return "—";
  const mins = Math.floor((Date.now() - start.getTime()) / 60000);
  if (mins < 1) return long ? "Just started" : "0m";
  if (mins < 60) return long ? `${mins} min` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (long) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

function updateShiftDateBadge() {
  const el = document.getElementById("shift-date-badge");
  if (!el) return;
  const now = new Date();
  el.innerHTML = `${UI_ICONS.calendar}<span>${now.toLocaleDateString("en-RW", {
    weekday: "short",
    month: "short",
    day: "numeric",
  })}</span>`;
}

function updateShiftHeroIcon(kind) {
  const iconEl = document.getElementById("shift-hero-icon");
  if (iconEl) iconEl.innerHTML = SHIFT_HERO_ICONS[kind] || SHIFT_HERO_ICONS.idle;
}

function stopShiftTimer() {
  if (shiftTimerInterval) {
    clearInterval(shiftTimerInterval);
    shiftTimerInterval = null;
  }
}

function startShiftTimer(openedAt) {
  stopShiftTimer();
  const aside = document.getElementById("shift-hero-aside");
  const timerEl = document.getElementById("shift-hero-timer");
  if (!aside || !timerEl) return;

  const tick = () => {
    timerEl.textContent = formatShiftDuration(openedAt);
    const metaDuration = document.getElementById("shift-meta-duration");
    if (metaDuration) metaDuration.textContent = formatShiftDuration(openedAt, true);
  };

  aside.hidden = false;
  tick();
  shiftTimerInterval = setInterval(tick, 30000);
}

function updateShiftHero(state, title, desc, badge, iconKind = "idle") {
  const hero = document.getElementById("shift-hero");
  const badgeEl = document.getElementById("shift-hero-badge");
  const titleEl = document.getElementById("shift-hero-title");
  const descEl = document.getElementById("shift-hero-desc");
  if (hero) hero.dataset.state = state;
  if (badgeEl) badgeEl.textContent = badge;
  if (titleEl) titleEl.textContent = title;
  if (descEl) descEl.textContent = desc;
  updateShiftHeroIcon(iconKind);
  if (state !== "open") {
    stopShiftTimer();
    const aside = document.getElementById("shift-hero-aside");
    if (aside) aside.hidden = true;
  }
}

function setShiftPanelsMode(mode) {
  const panels = document.getElementById("shift-panels");
  if (!panels) return;
  panels.classList.remove("is-idle", "is-active", "is-closed", "is-selling", "is-closing");
  if (mode) panels.classList.add(mode);
}

function paymentBarWidth(amount, total) {
  if (!total || total <= 0) return 0;
  return Math.max(4, Math.round((amount / total) * 100));
}

function renderPaymentRow(label, amount, total, cls) {
  const width = paymentBarWidth(amount, total);
  return `
    <div class="shift-payment-row">
      <span class="shift-payment-dot ${cls}"></span>
      <span class="shift-payment-label">${label}</span>
      <strong>${fmt.format(amount)}</strong>
      <div class="shift-payment-bar-wrap">
        <div class="shift-payment-bar ${cls}" style="width: ${width}%"></div>
      </div>
    </div>
  `;
}

function updateShiftSteps(activeStep) {
  const steps = document.querySelectorAll(".shift-step");
  const order = ["start", "sell", "close"];
  const activeIdx = order.indexOf(activeStep);

  steps.forEach((step) => {
    const stepName = step.dataset.step;
    const idx = order.indexOf(stepName);
    step.classList.remove("is-active", "is-done");
    if (idx < activeIdx) step.classList.add("is-done");
    else if (idx === activeIdx) step.classList.add("is-active");
  });
}

function groupShiftSalesByCheckout(sales) {
  if (!sales?.length) return [];
  const groups = new Map();
  for (const sale of sales) {
    const key = sale.checkout_ref || `line-${sale.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        created_at: sale.created_at,
        payment_method: sale.payment_method,
        table_name: sale.table_name || "",
        items: [],
        total: 0,
      });
    }
    const group = groups.get(key);
    group.items.push(sale);
    group.total += sale.total_amount;
  }
  return [...groups.values()];
}

function renderShiftSalesHistory(sales) {
  if (!sales?.length) {
    return `
      <div class="shift-sales-history">
        <h4>Sales this shift</h4>
        ${emptyState(UI_ICONS.sales, "No sales", "No sales were recorded during this shift.", true)}
      </div>
    `;
  }

  const groups = groupShiftSalesByCheckout(sales);
  const saleCount = sales.length;

  return `
    <div class="shift-sales-history">
      <div class="shift-sales-head">
        <h4>Sales this shift</h4>
        <span class="shift-sales-meta">${saleCount} line${saleCount === 1 ? "" : "s"} · ${groups.length} checkout${groups.length === 1 ? "" : "s"}</span>
      </div>
      <div class="shift-sales-list">
        ${groups
          .map(
            (group) => `
          <article class="shift-sale-card">
            <div class="shift-sale-card-head">
              <span class="shift-sale-time">${esc(formatTime(group.created_at))}</span>
              <span class="shift-sale-pay">${esc(paymentMethodLabel(group.payment_method))}</span>
              ${group.table_name ? `<span class="shift-sale-pay">${esc(group.table_name)}</span>` : ""}
              <strong class="shift-sale-total">${fmt.format(group.total)}</strong>
            </div>
            <ul class="shift-sale-items">
              ${group.items
                .map(
                  (item) => `
                <li>
                  <span class="shift-sale-item-name">${esc(item.product_name)}</span>
                  <span class="shift-sale-item-qty">× ${item.quantity}</span>
                  <span class="shift-sale-item-amount">${fmt.format(item.total_amount)}</span>
                </li>`
                )
                .join("")}
            </ul>
          </article>`
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderShiftSummary(shift, message) {
  const resultEl = document.getElementById("reconcile-result");
  if (!resultEl || !shift) return;

  const status = reconcileStatusLabel(shift.status_label || "balanced");
  const varianceLine =
    shift.status_label === "balanced"
      ? "All payment counts match the sales recorded for this shift."
      : "One or more payment methods do not match recorded sales.";

  const payTotal = (shift.cash_sales || 0) + (shift.momo_sales || 0) + (shift.visa_sales || 0);
  const varianceChip =
    shift.status_label === "balanced"
      ? "All balanced"
      : status.text;

  const notesHtml = renderCashNotesBreakdown(shift.cash_notes);
  const notesSection = notesHtml
    ? `<div class="cash-notes-breakdown"><h4>Cash note breakdown</h4>${notesHtml}</div>`
    : "";

  resultEl.innerHTML = `
    <div class="reconcile-summary">
      <div class="shift-result-layout">
        <div class="shift-result-hero ${status.cls}">
          <div class="shift-result-icon ${status.cls}">${status.icon}</div>
          <span class="shift-result-status ${status.cls}">${status.text}</span>
          <p class="shift-result-message">${esc(message || varianceLine)}</p>
          <p class="shift-range-label">${esc(formatShiftRange(shift))}</p>
          <span class="shift-variance-chip ${status.cls}">${esc(varianceChip)}</span>
        </div>
        <div class="shift-result-body">
          <div class="reconcile-grid">
            ${statCard("revenue", UI_ICONS.revenue, "Total sales", fmt.format(shift.total_sales), "All payment types")}
            ${isSeller() ? "" : statCard("sales", UI_ICONS.sales, "Line items", fmtNum.format(shift.sale_count || 0), "Sales recorded")}
            ${isSeller() ? "" : statCard("month", UI_ICONS.chart, "Units sold", fmtNum.format(shift.units_sold || 0), "This shift")}
          </div>
          <h4>Payment reconciliation</h4>
          ${renderPaymentReconcileCards(shift)}
          ${notesSection}
          <div class="reconcile-payments">
            <h4>Recorded breakdown</h4>
            ${renderPaymentRow("Cash", shift.cash_sales, payTotal, "cash")}
            ${renderPaymentRow("MoMo", shift.momo_sales, payTotal, "momo")}
            ${renderPaymentRow("Visa", shift.visa_sales, payTotal, "visa")}
          </div>
          ${isSeller() ? "" : renderShiftSalesHistory(shift.sales)}
        </div>
      </div>
      <p class="reconcile-closed-note">Shift closed — start a new one when you are ready to sell again.</p>
    </div>
  `;

  const heroState = `closed-${shift.status_label || "balanced"}`;
  updateShiftHero(
    heroState,
    status.text === "Balanced" ? "Shift closed — all good!" : `Shift closed — ${status.text.toLowerCase()}`,
    message || varianceLine,
    "Closed",
    "closed"
  );
  setShiftPanelsMode("is-closed");
  updateShiftSteps("close");
  document.querySelectorAll(".shift-step").forEach((s) => s.classList.add("is-done"));
}

function renderShiftView() {
  const startCard = document.getElementById("shift-start-card");
  const closeCard = document.getElementById("shift-close-card");
  const resultCard = document.getElementById("shift-result-card");
  const sellHint = document.getElementById("shift-sell-hint");
  const heroActions = document.getElementById("shift-hero-actions");
  const view = document.getElementById("view-reconcile");
  const joinableEl = document.getElementById("shift-joinable");
  const startTitle = document.getElementById("shift-start-title");
  const startDesc = document.getElementById("shift-start-desc");
  const startLabel = document.getElementById("btn-start-shift-label");

  const data = state.sellerShift;
  const open = data?.has_open_shift;
  const closedShift = !open && (data?.shift?.status === "closed" ? data.shift : data?.last_closed);
  const joinable = !open && !closedShift ? getJoinableShift() : null;

  if (startCard) startCard.hidden = open || !!closedShift;
  if (resultCard) resultCard.hidden = !closedShift;
  if (sellHint) sellHint.hidden = true;
  if (closeCard) closeCard.hidden = true;
  if (heroActions) heroActions.hidden = true;
  if (view && !open) view.classList.remove("is-closing-shift");

  if (joinableEl) {
    if (joinable) {
      joinableEl.hidden = false;
      const names = (joinable.members || [])
        .map((m) => esc(m.display_name))
        .join(", ");
      joinableEl.innerHTML = `
        <div class="shift-joinable-card">
          <strong>Open shift${joinable.supervisor_name ? ` · ${esc(joinable.supervisor_name)} on till` : ""}</strong>
          <p>${joinable.member_count || 1} seller${(joinable.member_count || 1) === 1 ? "" : "s"} on shift${names ? `: ${names}` : ""}.</p>
        </div>`;
    } else {
      joinableEl.hidden = true;
      joinableEl.innerHTML = "";
    }
  }
  if (startTitle) startTitle.textContent = joinable ? "Join shift" : "Start shift";
  if (startDesc) {
    startDesc.textContent = joinable
      ? "A shift is already open. Join it to sell — floor supervisors can close and reconcile."
      : "Tap start when you are at the counter. Floor supervisors can close for the team.";
  }
  if (startLabel) startLabel.textContent = joinable ? "Join shift" : "Start shift";

  if (open && data.shift) {
    const startedAt = formatDate(data.shift.opened_at);
    const lead = data.shift.supervisor_name;
    const iAmLead = canCloseShift();
    updateShiftHero(
      "open",
      iAmLead ? "Your shift is live — floor supervisor" : "You joined this shift",
      shiftUiPhase === "close" && iAmLead
        ? `Started ${startedAt}. Enter what was collected for cash, MoMo, and Visa for the whole team.`
        : iAmLead
          ? `Started ${startedAt}. Teammates can join and sell; you can close and reconcile.`
          : `Started ${startedAt}${lead ? ` · with ${lead}` : ""}. Sell as usual — a floor supervisor will reconcile.`,
      iAmLead ? "Supervisor" : "Joined",
      "open"
    );
    startShiftTimer(data.shift.opened_at);
    if (shiftUiPhase === "close" && !iAmLead) shiftUiPhase = "sell";
    renderShiftOpenPhase();
  } else if (closedShift && resultCard) {
    shiftUiPhase = "sell";
    renderShiftSummary(closedShift);
  } else {
    shiftUiPhase = "sell";
    updateShiftHero(
      "idle",
      joinable ? "Join the open shift" : "Ready to start your shift",
      joinable
        ? `Join the open shift${joinable.supervisor_name ? ` with ${joinable.supervisor_name}` : ""} to sell on the same till.`
        : "Tap start when you are at the counter. Floor supervisors close and reconcile for the team.",
      joinable ? "Join available" : "Not started",
      "idle"
    );
    setShiftPanelsMode("is-idle");
    updateShiftSteps("start");
  }
}

async function loadReconcileView() {
  if (!isSeller()) return;

  updateShiftDateBadge();
  const wantClose = pendingShiftUiPhase === "close";
  pendingShiftUiPhase = null;
  shiftUiPhase = "sell";

  try {
    await refreshSellerShift();
    shiftUiPhase = wantClose && canCloseShift() ? "close" : "sell";
    renderShiftView();
    updateSellShiftUi();
    if (shiftUiPhase === "close") {
      document.getElementById("cash-note-5000")?.focus();
    }
  } catch (err) {
    toast(err.message, "error");
  }
}

async function startSellerShift({ button, goToSell = false } = {}) {
  if (!isSeller()) return false;

  const buttons = [
    button,
    document.getElementById("btn-start-shift"),
    document.getElementById("btn-new-shift"),
    document.getElementById("btn-sell-start-shift"),
  ].filter(Boolean);
  const uniqueButtons = [...new Set(buttons)];
  uniqueButtons.forEach((btn) => {
    btn.disabled = true;
  });

  try {
    const data = await api("/api/seller/shift/start", {
      method: "POST",
      body: JSON.stringify({}),
    });
    state.sellerShift = data;
    shiftUiPhase = "sell";
    toast(data.message || (data.joined ? "Joined shift — you can sell now" : "Shift started — you can sell now"));
    renderShiftView();
    updateSellShiftUi();
    if (goToSell) switchView("sell");
    return true;
  } catch (err) {
    toast(err.message, "error");
    return false;
  } finally {
    uniqueButtons.forEach((btn) => {
      btn.disabled = false;
    });
  }
}

async function submitStartShift(e) {
  e.preventDefault();
  await startSellerShift({
    button: document.getElementById("btn-start-shift"),
    goToSell: true,
  });
}

async function startNewShiftFromResult() {
  await startSellerShift({
    button: document.getElementById("btn-new-shift"),
    goToSell: true,
  });
}

async function startShiftFromSell() {
  await startSellerShift({
    button: document.getElementById("btn-sell-start-shift"),
    goToSell: false,
  });
}

async function submitCloseShift(e) {
  e.preventDefault();
  if (!isSeller()) return;
  if (!canCloseShift()) {
    toast("Only a floor supervisor can close and reconcile.", "error");
    return;
  }

  const btn = document.getElementById("btn-reconcile");
  const cashNotes = readCashNotesFromForm();
  const countedMomo = readCountedPaymentAmount("counted-momo");
  const countedVisa = readCountedPaymentAmount("counted-visa");
  const concerns = document.getElementById("shift-concerns")?.value.trim() || "";
  const reportLowStock = document.getElementById("shift-report-low-stock")?.value.trim() || "";
  const reportIssues = document.getElementById("shift-report-issues")?.value.trim() || "";
  const reportWishes = document.getElementById("shift-report-wishes")?.value.trim() || "";

  btn.disabled = true;
  try {
    const data = await api("/api/seller/shift/close", {
      method: "POST",
      body: JSON.stringify({
        cash_notes: cashNotes,
        counted_momo: countedMomo,
        counted_visa: countedVisa,
        concerns,
        report_low_stock: reportLowStock,
        report_issues: reportIssues,
        report_wishes: reportWishes,
      }),
    });
    [
      "shift-concerns",
      "shift-report-low-stock",
      "shift-report-issues",
      "shift-report-wishes",
    ].forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.value = "";
    });
    state.sellerShift = {
      has_open_shift: false,
      can_close: false,
      my_role_on_shift: null,
      shift: data.shift,
      last_closed: data.shift,
    };
    renderShiftView();
    updateSellShiftUi();
    toast(data.message, data.shift.status_label === "balanced" ? "success" : "error");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

function initCashNoteInputs() {
  document.querySelectorAll(".cash-note-input").forEach((input) => {
    input.addEventListener("input", updateCashNotesTotal);
  });
}

// ── Ingredients ────────────────────────────────────────────────────────────

async function loadIngredients() {
  try {
    const search = document.getElementById("ingredient-search")?.value?.trim() || "";
    const lowOnly = document.getElementById("ingredient-low-stock-filter")?.checked;
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (lowOnly) params.set("low_stock", "1");
    const qs = params.toString();
    state.ingredients = await api(`/api/ingredients${qs ? `?${qs}` : ""}`);
    renderIngredientsTable();
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderIngredientsTable() {
  const tbody = document.getElementById("ingredients-table-body");
  const countEl = document.getElementById("ingredients-count");
  if (!tbody) return;
  const items = state.ingredients || [];
  if (countEl) countEl.textContent = `${items.length} ingredient${items.length === 1 ? "" : "s"}`;

  const role = state.currentUser?.role;
  const canManage = role === "admin" || role === "stock_manager";
  const showCost = canViewCost();

  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="7">${emptyState(
      UI_ICONS.box,
      "No ingredients yet",
      "Add raw materials like beetroot, sugar, or burger buns."
    )}</td></tr>`;
    return;
  }

  tbody.innerHTML = items
    .map((ing) => {
      const actions = canManage
        ? `<div class="action-group">
            <button class="btn-icon" title="Edit" onclick="openEditIngredient(${ing.id})">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-icon danger" title="Delete" onclick="openDeleteIngredient(${ing.id}, '${escAttr(ing.name)}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>`
        : `<span class="text-muted">View only</span>`;
      return `
      <tr>
        <td>${productCell(ing.name, esc(ing.unit))}</td>
        <td>${esc(ing.unit)}</td>
        <td><strong>${fmtNum.format(ing.quantity)}</strong></td>
        <td>${showCost && ing.cost_per_unit != null ? fmt.format(ing.cost_per_unit) : "—"}</td>
        <td>${fmtNum.format(ing.reorder_level)}</td>
        <td><span class="badge badge-stock ${ing.stock_status}">${stockLabel(ing)}</span></td>
        <td>${actions}</td>
      </tr>`;
    })
    .join("");
}

function openAddIngredient() {
  document.getElementById("ingredient-modal-title").textContent = "Add Ingredient";
  document.getElementById("ingredient-form").reset();
  document.getElementById("ingredient-id").value = "";
  document.getElementById("ingredient-unit").value = "g";
  document.getElementById("ingredient-quantity").value = "0";
  document.getElementById("ingredient-reorder").value = "0";
  document.getElementById("ingredient-cost").value = "0";
  const qtyGroup = document.getElementById("ingredient-qty-group");
  if (qtyGroup) qtyGroup.hidden = false;
  showModal("ingredient-modal");
}

async function openEditIngredient(id) {
  try {
    const ing = await api(`/api/ingredients/${id}`);
    document.getElementById("ingredient-modal-title").textContent = "Edit Ingredient";
    document.getElementById("ingredient-id").value = ing.id;
    document.getElementById("ingredient-name").value = ing.name;
    document.getElementById("ingredient-unit").value = ing.unit;
    document.getElementById("ingredient-reorder").value = ing.reorder_level;
    document.getElementById("ingredient-cost").value =
      ing.cost_per_unit != null ? ing.cost_per_unit : 0;
    const qtyGroup = document.getElementById("ingredient-qty-group");
    if (qtyGroup) qtyGroup.hidden = true;
    showModal("ingredient-modal");
  } catch (e) {
    toast(e.message, "error");
  }
}

function openDeleteIngredient(id, name) {
  state.deleteIngredientId = id;
  document.getElementById("delete-ingredient-name").textContent = name;
  showModal("delete-ingredient-modal");
}

async function saveIngredient(e) {
  e.preventDefault();
  const id = document.getElementById("ingredient-id").value;
  const payload = {
    name: document.getElementById("ingredient-name").value.trim(),
    unit: document.getElementById("ingredient-unit").value,
    reorder_level: parseFloat(document.getElementById("ingredient-reorder").value) || 0,
    cost_per_unit: parseFloat(document.getElementById("ingredient-cost").value) || 0,
  };
  if (!payload.name) {
    toast("Enter an ingredient name", "error");
    return;
  }
  if (!id) {
    payload.quantity = parseFloat(document.getElementById("ingredient-quantity").value) || 0;
  }
  try {
    if (id) {
      await api(`/api/ingredients/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      toast("Ingredient updated");
    } else {
      await api("/api/ingredients", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast("Ingredient added");
    }
    hideModal("ingredient-modal");
    loadIngredients();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function confirmDeleteIngredient() {
  try {
    await api(`/api/ingredients/${state.deleteIngredientId}`, { method: "DELETE" });
    toast("Ingredient deleted");
    hideModal("delete-ingredient-modal");
    loadIngredients();
  } catch (e) {
    toast(e.message, "error");
  }
}

function updateIngredientRestockPreview() {
  const preview = document.getElementById("ingredient-restock-preview");
  const id = parseInt(document.getElementById("ingredient-restock-select")?.value, 10);
  const ing = (state.ingredients || []).find((i) => i.id === id);
  if (!preview || !ing) {
    if (preview) preview.hidden = true;
    return;
  }
  const qty = parseFloat(document.getElementById("ingredient-restock-quantity")?.value) || 0;
  const costInput = document.getElementById("ingredient-restock-cost");
  if (costInput && document.activeElement !== costInput && ing.cost_per_unit != null) {
    if (!costInput.dataset.touched) {
      costInput.value = String(ing.cost_per_unit);
    }
  }
  preview.hidden = false;
  document.getElementById("ingredient-restock-preview-name").textContent = ing.name;
  document.getElementById("ingredient-restock-preview-meta").textContent =
    `${ing.unit} · cost ${fmt.format(ing.cost_per_unit || 0)} / ${ing.unit}`;
  document.getElementById("ingredient-restock-preview-current").textContent =
    `${fmtNum.format(ing.quantity)} ${ing.unit}`;
  document.getElementById("ingredient-restock-preview-after").textContent =
    `${fmtNum.format(ing.quantity + qty)} ${ing.unit}`;
}

async function submitIngredientRestock(e) {
  e.preventDefault();
  const ingredientId = parseInt(document.getElementById("ingredient-restock-select").value, 10);
  const quantity = parseFloat(document.getElementById("ingredient-restock-quantity").value);
  const unitCost = parseFloat(document.getElementById("ingredient-restock-cost").value) || 0;
  const notes = document.getElementById("ingredient-restock-notes").value;
  const expiryDate = document.getElementById("ingredient-restock-expiry")?.value || "";
  if (!ingredientId || !(quantity > 0)) {
    toast("Choose an ingredient and quantity", "error");
    return;
  }
  try {
    const payload = {
      ingredient_id: ingredientId,
      quantity,
      unit_cost: unitCost,
      notes,
    };
    if (expiryDate) payload.expiry_date = expiryDate;
    const updated = await api("/api/ingredients/restock", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const idx = state.ingredients.findIndex((i) => i.id === updated.id);
    if (idx >= 0) state.ingredients[idx] = updated;
    else state.ingredients.push(updated);
    toast(`Added ${quantity} ${updated.unit} of ${updated.name}`);
    document.getElementById("ingredient-restock-notes").value = "";
    const expiryInput = document.getElementById("ingredient-restock-expiry");
    if (expiryInput) expiryInput.value = "";
    const costInput = document.getElementById("ingredient-restock-cost");
    if (costInput) delete costInput.dataset.touched;
    populateIngredientRestockSelect();
    updateIngredientRestockPreview();
    renderRestockLowStock();
    loadLotsPanel();
  } catch (err) {
    toast(err.message, "error");
  }
}

// ── Restock ────────────────────────────────────────────────────────────────

function formatLotDate(iso) {
  if (!iso) return "—";
  const day = String(iso).slice(0, 10);
  return day || "—";
}

function lotExpiryBadge(lot) {
  if (!lot.expiry_date) return `<span class="text-muted">—</span>`;
  const today = new Date().toISOString().slice(0, 10);
  const expired = lot.expiry_date < today;
  const soon =
    !expired &&
    lot.expiry_date <=
      new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const cls = expired ? "lot-expiry expired" : soon ? "lot-expiry soon" : "lot-expiry";
  return `<span class="${cls}">${esc(lot.expiry_date)}</span>`;
}

async function loadLotsPanel() {
  const body = document.getElementById("lots-table-body");
  if (!body) return;
  const pool = document.getElementById("lots-pool-filter")?.value || "";
  const params = new URLSearchParams();
  if (pool) params.set("pool", pool);
  params.set("limit", "200");
  try {
    const lots = await api(`/api/lots?${params.toString()}`);
    state.lots = lots;
    renderLotsTable(lots);
  } catch (err) {
    body.innerHTML = `<tr><td colspan="7" class="text-muted">${esc(err.message)}</td></tr>`;
  }
}

function renderLotsTable(lots) {
  const body = document.getElementById("lots-table-body");
  if (!body) return;
  if (!lots.length) {
    body.innerHTML = `<tr><td colspan="7" class="text-muted">No open lots</td></tr>`;
    return;
  }
  body.innerHTML = lots
    .map(
      (lot) => `
    <tr>
      <td><strong>${esc(lot.item_name || "—")}</strong><div class="text-muted">#${lot.id} · ${esc(lot.source || "")}</div></td>
      <td>${esc(lot.pool || "")}</td>
      <td>${esc(formatLotDate(lot.received_at))}</td>
      <td>${lotExpiryBadge(lot)}</td>
      <td>${fmtNum.format(lot.qty_remaining)}</td>
      <td>${fmt.format(lot.unit_cost || 0)}</td>
      <td>${fmt.format(lot.value || 0)}</td>
    </tr>`
    )
    .join("");
}

async function loadAdjustLotsForProduct(productId) {
  const group = document.getElementById("adjust-lot-group");
  const select = document.getElementById("adjust-lot");
  if (!group || !select) return;
  select.innerHTML = `<option value="">FEFO — oldest / soonest expiry first</option>`;
  if (!productId) {
    group.hidden = true;
    return;
  }
  try {
    const lots = await api(`/api/lots?pool=product&ref_id=${productId}`);
    group.hidden = false;
    lots.forEach((lot) => {
      const exp = lot.expiry_date ? ` · exp ${lot.expiry_date}` : "";
      const opt = document.createElement("option");
      opt.value = String(lot.id);
      opt.textContent = `#${lot.id} · ${fmtNum.format(lot.qty_remaining)} left${exp} · ${fmt.format(lot.unit_cost || 0)}`;
      select.appendChild(opt);
    });
  } catch {
    group.hidden = true;
  }
}

async function loadRestockView() {
  try {
    const [products, cups, ingredients] = await Promise.all([
      api("/api/products"),
      api("/api/cups"),
      api("/api/ingredients"),
    ]);
    state.products = products;
    state.cupInventory = cups;
    state.ingredients = ingredients;
    populateProductSelects();
    renderCupRestock();
    renderRestockLowStock();
    updateRestockPreview();
    updateAdjustPreview();
    updateIngredientRestockPreview();
    loadLotsPanel();
    const adjustId = parseInt(document.getElementById("adjust-product")?.value, 10);
    if (adjustId) loadAdjustLotsForProduct(adjustId);
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderCupRestock() {
  const cups = state.cupInventory;
  if (!cups) return;

  const badge = document.getElementById("cup-stock-badge");
  if (badge) {
    badge.textContent = stockLabel({ ...cups, uses_cup_stock: true });
    badge.className = `badge badge-stock ${cups.stock_status}`;
  }

  document.getElementById("cup-preview-current").textContent = fmtNum.format(cups.quantity);
  updateCupRestockPreview();
}

function updateCupRestockPreview() {
  const cups = state.cupInventory;
  if (!cups) return;
  const qty = parseInt(document.getElementById("cup-restock-quantity")?.value, 10) || 0;
  document.getElementById("cup-preview-after").textContent = fmtNum.format(cups.quantity + qty);
}

async function submitCupRestock(e) {
  e.preventDefault();
  const quantity = parseInt(document.getElementById("cup-restock-quantity").value, 10);
  const notes = document.getElementById("cup-restock-notes").value;
  const expiryDate = document.getElementById("cup-restock-expiry")?.value || "";

  try {
    const payload = { quantity, notes };
    if (expiryDate) payload.expiry_date = expiryDate;
    state.cupInventory = await api("/api/cups/restock", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    toast(`Added ${quantity} cups`);
    document.getElementById("cup-restock-notes").value = "";
    const expiryInput = document.getElementById("cup-restock-expiry");
    if (expiryInput) expiryInput.value = "";
    renderCupRestock();
    renderRestockLowStock();
    loadLotsPanel();
    await loadProducts();
  } catch (err) {
    toast(err.message, "error");
  }
}

function renderRestockLowStock() {
  const el = document.getElementById("restock-low-stock");
  if (!el) return;

  const low = state.products
    .filter(
      (p) =>
        !p.uses_cup_stock &&
        !p.uses_recipe &&
        (p.stock_status === "low" || p.stock_status === "out")
    )
    .sort((a, b) => a.quantity - b.quantity);

  const lowIngredients = (state.ingredients || [])
    .filter((ing) => ing.stock_status === "low" || ing.stock_status === "out")
    .sort((a, b) => a.quantity - b.quantity)
    .map((ing) => ({
      id: ing.id,
      name: ing.name,
      category: `Ingredient · ${ing.unit}`,
      quantity: ing.quantity,
      reorder_level: ing.reorder_level,
      stock_status: ing.stock_status,
      is_ingredient: true,
      unit: ing.unit,
    }));

  const cupItems = [];
  if (state.cupInventory && ["low", "out"].includes(state.cupInventory.stock_status)) {
    cupItems.push({
      id: "cups",
      name: "Serving Cups",
      category: "Shared inventory",
      quantity: state.cupInventory.quantity,
      reorder_level: state.cupInventory.reorder_level,
      stock_status: state.cupInventory.stock_status,
      is_cup_pool: true,
    });
  }

  const allLow = [...cupItems, ...lowIngredients, ...low];

  if (!allLow.length) {
    el.innerHTML = emptyState(UI_ICONS.check, "All stocked up", "No products need restocking right now.", true);
    return;
  }

  el.innerHTML = allLow
    .map((p) => {
      let onclick = `selectRestockProduct(${p.id})`;
      if (p.is_cup_pool) {
        onclick = "document.getElementById('cup-restock-quantity')?.focus()";
      } else if (p.is_ingredient) {
        onclick = `selectIngredientRestock(${p.id})`;
      }
      const badge = p.is_cup_pool
        ? `${p.quantity} cups`
        : p.is_ingredient
          ? `${p.quantity} ${p.unit}`
          : `${p.quantity} left`;
      return `
    <button type="button" class="restock-pick-item" onclick="${onclick}">
      <div class="restock-pick-info">
        <div class="product-avatar product-avatar-sm">${esc(productInitials(p.name))}</div>
        <div>
          <strong>${esc(p.name)}</strong>
          <span>${esc(p.category)}${p.is_cup_pool ? "" : ` · reorder ${p.reorder_level}`}</span>
        </div>
      </div>
      <span class="badge badge-stock ${p.stock_status}">${badge}</span>
    </button>`;
    })
    .join("");
}

function selectIngredientRestock(id) {
  const sel = document.getElementById("ingredient-restock-select");
  if (sel) sel.value = String(id);
  updateIngredientRestockPreview();
  document.getElementById("ingredient-restock-quantity")?.focus();
}

function selectRestockProduct(id) {
  document.getElementById("restock-product").value = String(id);
  updateRestockPreview();
  document.getElementById("restock-quantity")?.focus();
}

function updateRestockPreview() {
  const preview = document.getElementById("restock-preview");
  const id = parseInt(document.getElementById("restock-product")?.value, 10);
  const product = state.products.find((p) => p.id === id);

  if (!preview || !product) {
    if (preview) preview.hidden = true;
    return;
  }

  const qty = parseInt(document.getElementById("restock-quantity")?.value, 10) || 0;
  const costInput = document.getElementById("restock-cost-price");
  if (costInput && document.activeElement !== costInput) {
    const currentCost = product.cost_price != null ? product.cost_price : 0;
    if (!costInput.dataset.touched) {
      costInput.value = String(currentCost);
    }
  }
  const cost = parseFloat(costInput?.value) || 0;
  preview.hidden = false;
  document.getElementById("restock-preview-avatar").textContent = productInitials(product.name);
  document.getElementById("restock-preview-name").textContent = product.name;
  document.getElementById("restock-preview-meta").textContent =
    `${product.category} · sell ${fmt.format(product.price)} · cost ${fmt.format(cost)}${qty ? ` · total ${fmt.format(cost * qty)}` : ""}`;
  document.getElementById("restock-preview-current").textContent = fmtNum.format(product.quantity);
  document.getElementById("restock-preview-after").textContent = fmtNum.format(product.quantity + qty);
}

function updateAdjustPreview() {
  const preview = document.getElementById("adjust-preview");
  const id = parseInt(document.getElementById("adjust-product")?.value, 10);
  const product = state.products.find((p) => p.id === id);

  if (!preview || !product) {
    if (preview) preview.hidden = true;
    return;
  }

  const newQty = parseInt(document.getElementById("adjust-quantity")?.value, 10);
  const hasNewQty = !Number.isNaN(newQty);
  preview.hidden = false;
  document.getElementById("adjust-preview-avatar").textContent = productInitials(product.name);
  document.getElementById("adjust-preview-name").textContent = product.name;
  document.getElementById("adjust-preview-meta").textContent = `${product.category} · ${fmt.format(product.price)} each`;
  document.getElementById("adjust-preview-current").textContent = fmtNum.format(product.quantity);
  document.getElementById("adjust-preview-new").textContent = hasNewQty ? fmtNum.format(newQty) : "—";

  const deltaEl = document.getElementById("adjust-delta");
  if (!deltaEl) return;

  if (!hasNewQty) {
    deltaEl.hidden = true;
    return;
  }

  const diff = newQty - product.quantity;
  deltaEl.hidden = false;
  if (diff > 0) {
    deltaEl.className = "adjust-delta positive";
    deltaEl.textContent = `+${diff} units`;
  } else if (diff < 0) {
    deltaEl.className = "adjust-delta negative";
    deltaEl.textContent = `${diff} units`;
  } else {
    deltaEl.className = "adjust-delta neutral";
    deltaEl.textContent = "No change";
  }
}

function adjustRestockQty(delta) {
  const input = document.getElementById("restock-quantity");
  if (!input) return;
  const next = Math.max(1, (parseInt(input.value, 10) || 1) + delta);
  input.value = String(next);
  updateRestockPreview();
}

async function submitRestock(e) {
  e.preventDefault();
  try {
    const costInput = document.getElementById("restock-cost-price");
    const expiryDate = document.getElementById("restock-expiry")?.value || "";
    const payload = {
      product_id: parseInt(document.getElementById("restock-product").value, 10),
      quantity: parseInt(document.getElementById("restock-quantity").value, 10),
      unit_price: parseFloat(costInput?.value) || 0,
      notes: document.getElementById("restock-notes").value,
    };
    if (expiryDate) payload.expiry_date = expiryDate;
    const result = await api("/api/restock", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    toast(`Restocked ${result.name} — now ${result.quantity} units`);
    document.getElementById("restock-form").reset();
    document.getElementById("restock-quantity").value = "10";
    if (costInput) {
      costInput.value = "0";
      delete costInput.dataset.touched;
    }
    document.getElementById("restock-preview").hidden = true;
    switchView("products");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function submitAdjust(e) {
  e.preventDefault();
  try {
    const lotId = document.getElementById("adjust-lot")?.value;
    const payload = {
      product_id: parseInt(document.getElementById("adjust-product").value, 10),
      new_quantity: parseInt(document.getElementById("adjust-quantity").value, 10),
      notes: document.getElementById("adjust-notes").value,
    };
    if (lotId) payload.lot_id = parseInt(lotId, 10);
    const result = await api("/api/adjust", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    toast(`Stock updated — ${result.name} now has ${result.quantity} units`);
    document.getElementById("adjust-form").reset();
    const lotGroup = document.getElementById("adjust-lot-group");
    if (lotGroup) lotGroup.hidden = true;
    loadRestockView();
  } catch (err) {
    toast(err.message, "error");
  }
}

document.getElementById("adjust-product")?.addEventListener("change", () => {
  const id = parseInt(document.getElementById("adjust-product").value, 10);
  const p = state.products.find((x) => x.id === id);
  if (p) document.getElementById("adjust-quantity").value = p.quantity;
  updateAdjustPreview();
  loadAdjustLotsForProduct(id || null);
});

document.getElementById("adjust-quantity")?.addEventListener("input", updateAdjustPreview);
document.getElementById("restock-product")?.addEventListener("change", () => {
  const costInput = document.getElementById("restock-cost-price");
  if (costInput) delete costInput.dataset.touched;
  updateRestockPreview();
});
document.getElementById("restock-quantity")?.addEventListener("input", updateRestockPreview);
document.getElementById("restock-cost-price")?.addEventListener("input", () => {
  const costInput = document.getElementById("restock-cost-price");
  if (costInput) costInput.dataset.touched = "1";
  updateRestockPreview();
});
document.getElementById("restock-qty-minus")?.addEventListener("click", () => adjustRestockQty(-1));
document.getElementById("restock-qty-plus")?.addEventListener("click", () => adjustRestockQty(1));

document.querySelectorAll(".qty-preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById("restock-quantity");
    if (!input) return;
    const add = parseInt(btn.dataset.qty, 10) || 0;
    input.value = String((parseInt(input.value, 10) || 0) + add);
    updateRestockPreview();
  });
});

// ── History ────────────────────────────────────────────────────────────────

async function loadSellers() {
  if (isSeller()) return;
  try {
    state.sellers = await api("/api/sellers");
    populateSellerFilter("history-seller-filter", state.historySellerId);
    populateSellerFilter("sales-seller-filter", state.salesSellerId);
  } catch {
    // Seller filters are optional if the request fails.
  }
}

function populateSellerFilter(selectId, selected = "") {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const current = selected || sel.value;
  sel.innerHTML =
    `<option value="">All Sellers</option>` +
    state.sellers
      .map(
        (s) =>
          `<option value="${s.id}"${String(s.id) === String(current) ? " selected" : ""}>${esc(s.display_name)}</option>`
      )
      .join("");
}

async function loadHistory() {
  const type = document.getElementById("history-type-filter").value;
  const sellerId = document.getElementById("history-seller-filter")?.value || "";
  const category = document.getElementById("history-category-filter")?.value || "";
  state.historySellerId = sellerId;

  const params = new URLSearchParams({ limit: "100" });
  if (type) params.set("type", type);
  if (sellerId) params.set("user_id", sellerId);
  if (category) params.set("category", category);

  try {
    const requests = [api(`/api/transactions?${params}`)];
    if (isSeller()) requests.push(loadHistoryShifts());
    const [transactions] = await Promise.all(requests);
    renderHistory(transactions);
  } catch (e) {
    toast(e.message, "error");
  }
}

async function loadHistoryShifts() {
  const url = `/api/shifts/report?preset=${state.historyShiftPreset || "today"}`;
  const report = await api(url);
  state.historyShiftsReport = report;
  renderHistoryShifts(report);
  return report;
}

function renderHistoryShifts(report) {
  const { shifts } = report;
  const listEl = document.getElementById("history-shifts-list");
  if (!listEl) return;

  if (!shifts.length) {
    listEl.innerHTML = emptyState(UI_ICONS.chart, "No shifts", "Closed shifts in this period will appear here.");
    renderHistoryShiftDetailPlaceholder();
    return;
  }

  const maxSales = Math.max(...shifts.map((s) => s.total_sales), 1);
  const selectedVisible = shifts.some((s) => s.id === state.selectedHistoryShiftId);
  if (!selectedVisible) state.selectedHistoryShiftId = shifts[0]?.id || null;

  listEl.innerHTML = shifts
    .map((shift) => buildShiftListItemHtml(shift, state.selectedHistoryShiftId, maxSales, "selectHistoryShift"))
    .join("");

  if (state.selectedHistoryShiftId) {
    loadHistoryShiftDetail(state.selectedHistoryShiftId);
  } else {
    renderHistoryShiftDetailPlaceholder();
  }
}

function shiftHasReport(shift) {
  return Boolean(
    shift.concerns ||
      shift.report_low_stock ||
      shift.report_issues ||
      shift.report_wishes
  );
}

function renderShiftReport(shift) {
  if (!shiftHasReport(shift)) return "";
  const items = [
    ["Low stock / to restock", shift.report_low_stock],
    ["Issues met", shift.report_issues],
    ["Wishes / suggestions", shift.report_wishes],
    ["Other notes", shift.concerns],
  ]
    .filter(([, value]) => value)
    .map(
      ([label, value]) =>
        `<div class="shift-report-item"><span class="shift-report-item-label">${label}</span><p>${esc(value)}</p></div>`
    )
    .join("");
  return `
    <div class="shift-detail-concerns">
      <h4>Seller's end-of-shift report</h4>
      ${items}
    </div>`;
}

function buildShiftListItemHtml(shift, selectedId, maxSales, selectFn) {
  const statusBadge =
    shift.status === "open"
      ? '<span class="shift-status-badge open">Open</span>'
      : shiftStatusBadge(shift.status_label);
  const timeLine =
    shift.status === "open"
      ? `Started ${formatTime(shift.opened_at)} · ${formatShiftDuration(shift.opened_at, true)}`
      : `${formatTime(shift.opened_at)} → ${formatTime(shift.closed_at)}`;
  const sellerName = isSeller() ? "Your shift" : esc(shift.seller_name);
  const memberNames = (shift.members || [])
    .filter((m) => m.role_on_shift !== "supervisor")
    .map((m) => m.display_name)
    .filter(Boolean);
  const teamLine =
    !isSeller() && memberNames.length
      ? `<span class="shift-list-meta">With ${esc(memberNames.join(", "))}</span>`
      : "";
  const concernBadge = shiftHasReport(shift)
    ? '<span class="shift-concern-badge" title="Seller left an end-of-shift report">!</span>'
    : "";
  const salesMeta = `${fmtNum.format(shift.sale_count)} sale${shift.sale_count !== 1 ? "s" : ""} · ${fmtNum.format(shift.units_sold)} units`;
  return `
    <button type="button" class="sales-date-item shift-list-item ${selectedId === shift.id ? "active" : ""}"
      onclick="${selectFn}(${shift.id})">
      <div class="sales-date-info">
        <div class="shift-list-head">
          <strong>${sellerName}</strong>
          ${statusBadge}${concernBadge}
        </div>
        <span class="shift-list-meta">${timeLine}</span>
        ${teamLine}
        <span class="shift-list-meta">${salesMeta}</span>
      </div>
      <div class="sales-date-revenue">${fmt.format(shift.total_sales)}</div>
      <div class="sales-date-bar" style="width:${(shift.total_sales / maxSales) * 100}%"></div>
    </button>`;
}

function renderHistoryShiftDetailPlaceholder() {
  const title = document.getElementById("history-shift-detail-title");
  const subtitle = document.getElementById("history-shift-detail-subtitle");
  const body = document.getElementById("history-shift-detail-body");
  if (title) title.textContent = "Shift Detail";
  if (subtitle) subtitle.textContent = "";
  if (body) {
    body.innerHTML = '<p class="text-muted shift-detail-placeholder">Select a shift to view details</p>';
  }
}

async function selectHistoryShift(shiftId) {
  state.selectedHistoryShiftId = shiftId;
  if (state.historyShiftsReport) renderHistoryShifts(state.historyShiftsReport);
  await loadHistoryShiftDetail(shiftId);
}

async function loadHistoryShiftDetail(shiftId) {
  try {
    const shift = await api(`/api/shifts/${shiftId}`);
    renderShiftDetail(shift, {
      title: "history-shift-detail-title",
      subtitle: "history-shift-detail-subtitle",
      body: "history-shift-detail-body",
      ownShift: isSeller(),
    });
  } catch (e) {
    toast(e.message, "error");
  }
}

function initHistoryShiftFilters() {
  document.querySelectorAll("[data-history-shift-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-history-shift-preset]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.historyShiftPreset = btn.dataset.historyShiftPreset;
      state.selectedHistoryShiftId = null;
      loadHistoryShifts().catch((e) => toast(e.message, "error"));
    });
  });
}

function groupHistorySales(transactions) {
  const sales = transactions.filter((t) => t.type === "sale");
  const other = transactions.filter((t) => t.type !== "sale");
  const groups = new Map();

  for (const sale of sales) {
    const key = sale.checkout_ref || `line-${sale.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        checkout_ref: key,
        created_at: sale.created_at,
        payment_method: sale.payment_method,
        seller_name: sale.seller_name,
        user_id: sale.user_id,
        table_id: sale.table_id,
        table_name: sale.table_name,
        items: [],
        total: 0,
        units: 0,
        is_voided: !!sale.is_voided,
        notes: sale.notes,
      });
    }
    const group = groups.get(key);
    group.items.push(sale);
    group.total += sale.total_amount;
    group.units += sale.quantity;
    group.is_voided = group.is_voided || !!sale.is_voided;
  }

  const groupedSales = [...groups.values()].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );
  return { groupedSales, other };
}

function historySaleProductCell(group) {
  if (group.items.length === 1) {
    const item = group.items[0];
    return productCell(item.product_name, esc(item.category));
  }
  const names = group.items.map((i) => esc(i.product_name)).join(", ");
  return `<div class="history-sale-group"><strong>${group.items.length} items</strong><span class="text-muted">${names}</span></div>`;
}

function historyVoidAction(group) {
  const canInvoice = group.checkout_ref && !group.checkout_ref.startsWith("line-");
  const invoiceBtn = canInvoice
    ? `<button type="button" class="btn btn-ghost btn-sm" onclick="showInvoiceFromHistory('${escAttr(group.checkout_ref)}')">Invoice</button>`
    : "";

  if (group.is_voided) {
    return `<div class="history-actions">${invoiceBtn}<span class="badge badge-muted">Voided</span></div>`;
  }
  if (!canInvoice) {
    return "—";
  }
  const voidBtn = `<button type="button" class="btn btn-ghost btn-sm btn-danger-text" onclick="openVoidSaleModal('${escAttr(group.checkout_ref)}')">Void</button>`;
  return `<div class="history-actions">${invoiceBtn}${voidBtn}</div>`;
}

function renderHistory(transactions) {
  const tbody = document.getElementById("history-table-body");
  const hideSellerCol = isSeller();
  const colCount = hideSellerCol ? 9 : 10;

  if (!transactions.length) {
    tbody.innerHTML = `<tr><td colspan="${colCount}">${emptyState(UI_ICONS.clock, "No transactions", hideSellerCol ? "Your sales will appear here." : "Sales, restocks, and adjustments will appear here.")}</td></tr>`;
    state.historySaleGroups = new Map();
    return;
  }

  const { groupedSales, other } = groupHistorySales(transactions);
  state.historySaleGroups = new Map(groupedSales.map((g) => [g.checkout_ref, g]));

  const saleRows = groupedSales
    .map(
      (group) => `
    <tr class="${group.is_voided ? "history-row-voided" : ""}">
      <td>${formatDate(group.created_at)}</td>
      <td>${historySaleProductCell(group)}</td>
      <td>${typeBadge("sale")}${group.is_voided ? ' <span class="badge badge-muted">Voided</span>' : ""}</td>
      <td>${fmtNum.format(group.units)}</td>
      <td>${fmt.format(group.total)}</td>
      <td>${tableLabel(group)}</td>
      <td>${paymentMethodLabel(group.payment_method)}</td>
      ${hideSellerCol ? "" : `<td>${sellerLabel(group)}</td>`}
      <td style="color:var(--text-muted);font-size:0.82rem">${esc(group.checkout_ref || group.notes || "—")}</td>
      <td>${historyVoidAction(group)}</td>
    </tr>`
    )
    .join("");

  const otherRows = other
    .map(
      (t) => `
    <tr>
      <td>${formatDate(t.created_at)}</td>
      <td>${productCell(t.product_name, esc(t.category))}</td>
      <td>${typeBadge(t.type)}</td>
      <td>${formatTransactionQty(t)}</td>
      <td>${t.type === "sale" ? fmt.format(t.total_amount) : "—"}</td>
      <td>${t.type === "sale" ? tableLabel(t) : "—"}</td>
      <td>${t.type === "sale" ? paymentMethodLabel(t.payment_method) : "—"}</td>
      ${hideSellerCol ? "" : `<td>${t.type === "sale" ? sellerLabel(t) : "—"}</td>`}
      <td style="color:var(--text-muted);font-size:0.82rem">${esc(t.notes || "—")}</td>
      <td>—</td>
    </tr>`
    )
    .join("");

  tbody.innerHTML = saleRows + otherRows;
}

function openVoidSaleModal(checkoutRef) {
  state.voidCheckoutRef = checkoutRef;
  const label = document.getElementById("void-sale-ref-label");
  if (label) label.textContent = `Reference: ${checkoutRef}`;
  const pwd = document.getElementById("void-admin-password");
  if (pwd) pwd.value = "";
  showModal("void-sale-modal");
  pwd?.focus();
}

async function submitVoidSale(e) {
  e.preventDefault();
  const checkoutRef = state.voidCheckoutRef;
  const password = document.getElementById("void-admin-password")?.value || "";
  if (!checkoutRef) return;

  try {
    const data = await api("/api/sales/void", {
      method: "POST",
      body: JSON.stringify({ checkout_ref: checkoutRef, admin_password: password }),
    });
    hideModal("void-sale-modal");
    state.voidCheckoutRef = null;
    toast(data.message || "Sale voided", "success");
    await loadHistory();
    if (!isSeller()) loadDashboard();
  } catch (err) {
    toast(err.message, "error");
  }
}

// ── Sales Reports ──────────────────────────────────────────────────────────

function setSalesReportMode(mode) {
  state.salesReportMode = mode;
  const datePanel = document.getElementById("sales-date-report");
  const shiftPanel = document.getElementById("sales-shift-report");
  const subtitle = document.getElementById("sales-report-subtitle");

  document.querySelectorAll(".sales-mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.salesMode === mode);
  });

  if (datePanel) datePanel.hidden = mode !== "date";
  if (shiftPanel) shiftPanel.hidden = mode !== "shift";

  if (subtitle) {
    subtitle.textContent =
      mode === "shift"
        ? "Review seller shifts — start and end times, sales totals, and reconciliation"
        : "Track revenue by day, week, month, or custom range";
  }
}

function syncSalesUiFromState() {
  // Sync period button active class to match restored state
  document.querySelectorAll(".period-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.preset === state.salesPreset);
  });

  // Show/hide custom range bar and pre-fill saved dates
  const customBar = document.getElementById("custom-range-bar");
  if (customBar) customBar.hidden = state.salesPreset !== "custom";
  if (state.salesPreset === "custom") {
    const fromInput = document.getElementById("sales-from");
    const toInput = document.getElementById("sales-to");
    if (fromInput && state.salesFrom) fromInput.value = state.salesFrom;
    if (toInput && state.salesTo) toInput.value = state.salesTo;
  }

  // Sync mode buttons and panel visibility
  document.querySelectorAll(".sales-mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.salesMode === state.salesReportMode);
  });
  const datePanel = document.getElementById("sales-date-report");
  const shiftPanel = document.getElementById("sales-shift-report");
  if (datePanel) datePanel.hidden = state.salesReportMode !== "date";
  if (shiftPanel) shiftPanel.hidden = state.salesReportMode !== "shift";
}

function loadSalesViewData(from, to) {
  // When preset is "custom" but no explicit dates passed, use stored dates as fallback
  const f = from ?? (state.salesPreset === "custom" ? state.salesFrom : undefined);
  const t = to ?? (state.salesPreset === "custom" ? state.salesTo : undefined);
  if (canViewShiftReports() && state.salesReportMode === "shift") {
    loadShiftsReport(f, t);
  } else {
    loadSalesReports(f, t);
  }
}

function initSalesReports() {
  document.querySelectorAll(".sales-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.salesMode === state.salesReportMode) return;
      setSalesReportMode(btn.dataset.salesMode);
      state.selectedShiftId = null;
      loadSalesViewData();
    });
  });

  document.querySelectorAll(".period-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".period-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.salesPreset = btn.dataset.preset;
      document.getElementById("custom-range-bar").hidden = state.salesPreset !== "custom";
      if (state.salesPreset !== "custom") {
        state.selectedSalesDate = null;
        state.selectedShiftId = null;
        loadSalesViewData();
      }
    });
  });

  document.getElementById("btn-apply-range").addEventListener("click", () => {
    const from = document.getElementById("sales-from").value;
    const to = document.getElementById("sales-to").value;
    if (!from || !to) {
      toast("Please select both start and end dates", "error");
      return;
    }
    if (from > to) {
      toast("Start date must be before end date", "error");
      return;
    }
    state.selectedSalesDate = null;
    state.selectedShiftId = null;
    loadSalesViewData(from, to);
  });
}

async function loadSalesReports(from, to) {
  try {
    const sellerId = document.getElementById("sales-seller-filter")?.value || "";
    state.salesSellerId = sellerId;

    let url = "/api/sales/report?";
    if (state.salesPreset === "custom" && from && to) {
      url += `from=${from}&to=${to}`;
    } else if (state.salesPreset !== "custom") {
      url += `preset=${state.salesPreset}`;
    } else {
      // custom preset with no dates — fall back to today
      url += `preset=today`;
    }
    if (sellerId) url += `&user_id=${encodeURIComponent(sellerId)}`;

    state.salesReport = await api(url);
    state.salesFrom = state.salesReport.from;
    state.salesTo = state.salesReport.to;
    renderSalesReport(state.salesReport);
  } catch (e) {
    toast(e.message, "error");
  }
}

const PAYMENT_COLORS = {
  cash: "#6b8f71",
  momo: "#d4a03c",
  card: "#5d7fa3",
  visa: "#5d7fa3",
  credit: "#b07a4a",
  other: "#a89888",
};

function renderSalesTrendChart(dailyBreakdown, selectedDate) {
  const canvas = document.getElementById("chart-sales-trend");
  destroyChart("salesTrend");
  if (!canvas || typeof Chart === "undefined" || !dailyBreakdown.length) return;

  const labels = dailyBreakdown.map((d) => {
    const dt = new Date(d.date + "T00:00:00");
    return dailyBreakdown.length === 1
      ? formatDateLabel(d.date)
      : dt.toLocaleDateString("en", { month: "short", day: "numeric" });
  });
  const revenues = dailyBreakdown.map((d) => d.revenue);
  const units = dailyBreakdown.map((d) => d.units);

  const bgColors = dailyBreakdown.map((d) =>
    d.date === selectedDate ? "#5d4037" : "rgba(196,165,116,0.42)"
  );
  const borderColors = dailyBreakdown.map((d) =>
    d.date === selectedDate ? "#3d2618" : "rgba(196,165,116,0.65)"
  );

  state.charts.salesTrend = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Revenue",
          data: revenues,
          backgroundColor: bgColors,
          borderColor: borderColors,
          borderWidth: 1.5,
          borderRadius: 5,
          borderSkipped: false,
          order: 2,
        },
        {
          label: "Units",
          data: units,
          type: "line",
          borderColor: "rgba(107,143,113,0.65)",
          backgroundColor: "rgba(107,143,113,0.07)",
          borderWidth: 1.75,
          pointBackgroundColor: "rgba(107,143,113,0.85)",
          pointRadius: dailyBreakdown.length > 20 ? 2 : 3,
          pointHoverRadius: 5,
          fill: true,
          tension: 0.35,
          yAxisID: "yUnits",
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      onClick: (_e, elements) => {
        if (elements.length) {
          const idx = elements[0].index;
          selectSalesDate(dailyBreakdown[idx].date);
        }
      },
      plugins: {
        legend: {
          display: true,
          position: "top",
          align: "end",
          labels: {
            boxWidth: 10,
            boxHeight: 10,
            borderRadius: 3,
            useBorderRadius: true,
            padding: 12,
            font: { size: 11, family: "'Plus Jakarta Sans', system-ui" },
            color: "#7a6a5e",
          },
        },
        tooltip: {
          backgroundColor: "rgba(44,24,16,0.92)",
          titleColor: "rgba(245,230,211,0.7)",
          bodyColor: "#f5e6d3",
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            title: (items) => items[0].label,
            label: (ctx) =>
              ctx.dataset.label === "Revenue"
                ? `  Revenue: ${fmt.format(ctx.parsed.y)}`
                : `  Units: ${fmtNum.format(ctx.parsed.y)}`,
            afterBody: () => ["  Click bar to filter detail table"],
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: {
            font: { size: 11, family: "'Plus Jakarta Sans', system-ui" },
            color: "#7a6a5e",
            maxRotation: 45,
            autoSkip: true,
            maxTicksLimit: 14,
          },
        },
        y: {
          position: "left",
          grid: { color: "rgba(232,221,208,0.45)", drawTicks: false },
          border: { display: false },
          ticks: {
            font: { size: 11, family: "'Plus Jakarta Sans', system-ui" },
            color: "#7a6a5e",
            padding: 6,
            callback: (v) => fmt.format(v),
          },
        },
        yUnits: {
          position: "right",
          grid: { display: false },
          border: { display: false },
          ticks: {
            font: { size: 11, family: "'Plus Jakarta Sans', system-ui" },
            color: "rgba(107,143,113,0.7)",
            padding: 6,
          },
        },
      },
    },
  });
}

function renderSalesDonut(canvasId, legendId, items, labelKey, valueKey, colorFn) {
  const canvas = document.getElementById(canvasId);
  const legendEl = document.getElementById(legendId);
  const chartKey = canvasId.replace("chart-", "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  destroyChart(chartKey);

  if (!canvas || typeof Chart === "undefined") return;

  const filtered = (items || []).filter((item) => item[valueKey] > 0);

  if (!filtered.length) {
    if (legendEl) legendEl.innerHTML = `<p style="font-size:0.78rem;color:var(--text-subtle)">No data</p>`;
    return;
  }

  const labels = filtered.map((item) => item[labelKey]);
  const data = filtered.map((item) => item[valueKey]);
  const colors = filtered.map((item, i) => colorFn(item, i));
  const total = data.reduce((s, v) => s + v, 0);

  state.charts[chartKey] = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: colors,
          borderColor: "#ffffff",
          borderWidth: 2,
          hoverOffset: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: "66%",
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(44,24,16,0.92)",
          bodyColor: "#f5e6d3",
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => {
              const pct = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
              return `  ${ctx.label}: ${fmt.format(ctx.parsed)} (${pct}%)`;
            },
          },
        },
      },
    },
  });

  if (legendEl) {
    legendEl.innerHTML = filtered
      .map(
        (item, i) => `
      <div class="donut-legend-item">
        <span class="donut-legend-dot" style="background:${colors[i]}"></span>
        <span class="donut-legend-name">${esc(item[labelKey])}</span>
        <span class="donut-legend-value">${fmt.format(item[valueKey])}</span>
      </div>`
      )
      .join("");
  }
}

function renderSalesReport(report) {
  const { summary, daily_breakdown, payment_breakdown, category_breakdown, sales, from, to } = report;

  const marginLabel =
    summary.gross_margin_pct != null
      ? `${summary.gross_margin_pct}% margin`
      : "Set purchase prices to track profit";
  document.getElementById("sales-summary-stats").innerHTML = `
    ${statCard("revenue", UI_ICONS.revenue, "Total Revenue", fmt.format(summary.revenue), formatRangeLabel(from, to))}
    ${statCard("sales", UI_ICONS.sales, "Gross Profit", fmt.format(summary.gross_profit || 0), marginLabel)}
    ${statCard("stock", UI_ICONS.chart, "Cost of Goods", fmt.format(summary.cogs || 0), `${fmtNum.format(summary.units)} units sold`)}
    ${statCard("alert", UI_ICONS.calendar, "Active Days", daily_breakdown.length, `${fmtNum.format(summary.transactions)} sales recorded`)}
  `;

  document.getElementById("sales-range-label").textContent = formatRangeLabel(from, to);

  const chartsRow = document.getElementById("sales-charts-row");
  const trendLabel = document.getElementById("sales-trend-label");
  const datesList = document.getElementById("sales-dates-list");

  if (!daily_breakdown.length) {
    if (chartsRow) chartsRow.hidden = true;
    destroyChart("salesTrend");
    destroyChart("salesPayment");
    destroyChart("salesCat");
    datesList.innerHTML = emptyState(UI_ICONS.chart, "No sales", "No sales recorded in this period.");
    renderSalesDetail([], null);
    return;
  }

  if (chartsRow) chartsRow.hidden = false;
  if (trendLabel) trendLabel.textContent = formatRangeLabel(from, to);

  requestAnimationFrame(() => {
    renderSalesTrendChart(daily_breakdown, state.selectedSalesDate);
    renderSalesDonut(
      "chart-sales-payment", "sales-payment-legend",
      payment_breakdown, "label", "revenue",
      (p) => PAYMENT_COLORS[p.method] || "#c4a574"
    );
    renderSalesDonut(
      "chart-sales-cat", "sales-cat-legend",
      category_breakdown, "name", "revenue",
      (c) => categoryAccent(c.name)
    );
  });

  const maxRevenue = Math.max(...daily_breakdown.map((d) => d.revenue), 1);
  datesList.innerHTML = daily_breakdown
    .map(
      (day) => `
    <button type="button" class="sales-date-item ${state.selectedSalesDate === day.date ? "active" : ""}"
      onclick="selectSalesDate('${day.date}')">
      <div class="sales-date-info">
        <strong>${formatDateLabel(day.date)}</strong>
        <span>${fmtNum.format(day.transactions)} sale${day.transactions !== 1 ? "s" : ""} · ${fmtNum.format(day.units)} units</span>
      </div>
      <div class="sales-date-revenue">${fmt.format(day.revenue)}</div>
      <div class="sales-date-bar" style="width:${(day.revenue / maxRevenue) * 100}%"></div>
    </button>`
    )
    .join("");

  const detailSales = state.selectedSalesDate
    ? sales.filter((s) => s.sale_date === state.selectedSalesDate)
    : sales;
  const detailDate = state.selectedSalesDate || (from === to ? from : null);
  renderSalesDetail(detailSales, detailDate, from, to);
}

function renderSalesDetail(sales, date, from, to) {
  const title = document.getElementById("sales-detail-title");
  const subtitle = document.getElementById("sales-detail-subtitle");
  const tbody = document.getElementById("sales-detail-body");

  if (date) {
    title.textContent = `Sales on ${formatDateLabel(date)}`;
    subtitle.textContent = `${sales.length} transaction${sales.length !== 1 ? "s" : ""}`;
  } else if (from && to) {
    title.textContent = "All Sales in Period";
    subtitle.textContent = formatRangeLabel(from, to);
  } else {
    title.textContent = "Sales Detail";
    subtitle.textContent = "";
  }

  if (!sales.length) {
    const cols = isSeller() ? 6 : 7;
    tbody.innerHTML = `<tr><td colspan="${cols}">${emptyState(UI_ICONS.sales, "No sales", "Select a date or adjust your date range.")}</td></tr>`;
    return;
  }

  tbody.innerHTML = sales
    .map(
      (s) => `
    <tr>
      <td>${formatTime(s.created_at)}</td>
      <td>
        ${productCell(s.product_name, esc(s.category))}
      </td>
      <td>${s.quantity}</td>
      <td><strong>${fmt.format(s.total_amount)}</strong></td>
      <td>${tableLabel(s)}</td>
      <td>${paymentMethodLabel(s.payment_method)}</td>
      ${isSeller() ? "" : `<td>${sellerLabel(s)}</td>`}
    </tr>`
    )
    .join("");
}

function selectSalesDate(date) {
  state.selectedSalesDate = state.selectedSalesDate === date ? null : date;
  if (state.salesReport) {
    renderSalesReport(state.salesReport);
  }
}

async function loadShiftsReport(from, to) {
  try {
    const sellerId = document.getElementById("sales-seller-filter")?.value || "";
    state.salesSellerId = sellerId;

    let url = "/api/shifts/report?";
    if (state.salesPreset === "custom" && from && to) {
      url += `from=${from}&to=${to}`;
    } else if (state.salesPreset !== "custom") {
      url += `preset=${state.salesPreset}`;
    } else {
      // custom preset with no dates — fall back to today
      url += `preset=today`;
    }
    if (sellerId) url += `&user_id=${encodeURIComponent(sellerId)}`;

    state.shiftsReport = await api(url);
    state.salesFrom = state.shiftsReport.from;
    state.salesTo = state.shiftsReport.to;
    renderShiftsReport(state.shiftsReport);

    if (state.selectedShiftId) {
      const stillVisible = state.shiftsReport.shifts.some((s) => s.id === state.selectedShiftId);
      if (stillVisible) {
        await loadShiftDetail(state.selectedShiftId);
      } else {
        state.selectedShiftId = null;
        renderShiftDetailPlaceholder();
      }
    }
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderShiftsReport(report) {
  const { summary, payment_breakdown, shifts, from, to } = report;

  document.getElementById("shifts-summary-stats").innerHTML = `
    ${statCard("revenue", UI_ICONS.revenue, "Total Sales", fmt.format(summary.total_sales), formatRangeLabel(from, to))}
    ${statCard("sales", UI_ICONS.sales, "Shifts", fmtNum.format(summary.shift_count), `${summary.closed_shifts} closed · ${summary.open_shifts} open`)}
    ${statCard("stock", UI_ICONS.chart, "Units Sold", fmtNum.format(summary.units_sold), `${fmtNum.format(summary.sale_count)} line items`)}
    ${statCard("alert", UI_ICONS.calendar, "Net Variance", fmt.format(Math.abs(summary.total_variance)), summary.total_variance === 0 ? "All shifts balanced" : summary.total_variance > 0 ? "Over overall" : "Short overall")}
  `;

  const payments = payment_breakdown || [];
  const breakdownEl = document.getElementById("shifts-payment-breakdown");
  if (breakdownEl) {
    breakdownEl.innerHTML = `
      <h3 class="payment-breakdown-title">Sales by Payment</h3>
      <div class="payment-breakdown-grid">
        ${payments
          .map(
            (p) => `
          <div class="payment-breakdown-card payment-${p.method}">
            <span class="payment-breakdown-label">${esc(p.label)}</span>
            <strong class="payment-breakdown-value">${fmt.format(p.revenue)}</strong>
            <span class="payment-breakdown-sub">across all shifts</span>
          </div>`
          )
          .join("")}
      </div>
    `;
  }

  document.getElementById("shifts-range-label").textContent = formatRangeLabel(from, to);

  const listEl = document.getElementById("shifts-list");
  if (!shifts.length) {
    listEl.innerHTML = emptyState(UI_ICONS.chart, "No shifts", "No seller shifts in this period.");
    renderShiftDetailPlaceholder();
    return;
  }

  const maxSales = Math.max(...shifts.map((s) => s.total_sales), 1);
  listEl.innerHTML = shifts
    .map((shift) => buildShiftListItemHtml(shift, state.selectedShiftId, maxSales, "selectShift"))
    .join("");

  if (!state.selectedShiftId && shifts.length) {
    selectShift(shifts[0].id);
  }
}

function shiftStatusBadge(statusLabel) {
  if (statusLabel === "balanced") {
    return '<span class="shift-status-badge balanced">Balanced</span>';
  }
  if (statusLabel === "over") {
    return '<span class="shift-status-badge over">Over</span>';
  }
  return '<span class="shift-status-badge short">Short</span>';
}

function renderShiftDetailPlaceholder() {
  document.getElementById("shift-detail-title").textContent = "Shift Detail";
  document.getElementById("shift-detail-subtitle").textContent = "";
  document.getElementById("shift-detail-body").innerHTML =
    '<p class="text-muted shift-detail-placeholder">Select a shift to view details</p>';
}

async function loadShiftDetail(shiftId) {
  try {
    const shift = await api(`/api/shifts/${shiftId}`);
    renderShiftDetail(shift);
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderShiftDetail(shift, targets = {}) {
  const title = document.getElementById(targets.title || "shift-detail-title");
  const subtitle = document.getElementById(targets.subtitle || "shift-detail-subtitle");
  const body = document.getElementById(targets.body || "shift-detail-body");
  if (!title || !body) return;

  title.textContent = targets.ownShift ? "Your Shift" : `${shift.seller_name}'s Shift`;
  if (subtitle) subtitle.textContent = formatShiftRange(shift);

  const payTotal = (shift.cash_sales || 0) + (shift.momo_sales || 0) + (shift.visa_sales || 0);
  const isOpen = shift.status === "open";
  const status = shift.status_label ? reconcileStatusLabel(shift.status_label) : null;

  let reconcileSection = "";
  if (!isOpen && status) {
    const varianceChip =
      shift.status_label === "balanced"
        ? "All balanced"
        : status.text;
    reconcileSection = `
      <div class="shift-detail-reconcile ${status.cls}">
        <div class="shift-detail-reconcile-head">
          <span class="shift-result-status ${status.cls}">${status.text}</span>
          <span class="shift-variance-chip ${status.cls}">${esc(varianceChip)}</span>
        </div>
        <div class="reconcile-grid shift-detail-stats">
          ${statCard("revenue", UI_ICONS.revenue, "Recorded", fmt.format(shift.total_sales), "System total")}
          ${statCard("sales", UI_ICONS.sales, "Line items", fmtNum.format(shift.sale_count || 0), "Sales recorded")}
          ${statCard("month", UI_ICONS.chart, "Units sold", fmtNum.format(shift.units_sold || 0), "This shift")}
        </div>
        <h4>Payment reconciliation</h4>
        ${renderPaymentReconcileCards(shift)}
        ${renderCashNotesBreakdown(shift.cash_notes) ? `<div class="cash-notes-breakdown shift-detail-notes"><h4>Cash notes</h4>${renderCashNotesBreakdown(shift.cash_notes)}</div>` : ""}
      </div>
    `;
  } else if (isOpen) {
    reconcileSection = `
      <div class="shift-detail-reconcile open">
        <p class="shift-detail-open-note">This shift is still open — totals update live as sales are recorded.</p>
        <div class="reconcile-grid shift-detail-stats">
          ${statCard("revenue", UI_ICONS.revenue, "Sales so far", fmt.format(shift.total_sales), "Live total")}
          ${statCard("sales", UI_ICONS.sales, "Line items", fmtNum.format(shift.sale_count), "sales recorded")}
          ${statCard("stock", UI_ICONS.chart, "Units", fmtNum.format(shift.units_sold), "sold this shift")}
        </div>
      </div>
    `;
  }

  const concernsSection = renderShiftReport(shift);

  body.innerHTML = `
    ${reconcileSection}
    ${concernsSection}
    <div class="reconcile-payments shift-detail-payments">
      <h4>Payment breakdown</h4>
      ${renderPaymentRow("Cash", shift.cash_sales, payTotal, "cash")}
      ${renderPaymentRow("MoMo", shift.momo_sales, payTotal, "momo")}
      ${renderPaymentRow("Visa", shift.visa_sales, payTotal, "visa")}
    </div>
    ${renderShiftSalesHistory(shift.sales)}
  `;
}

async function selectShift(shiftId) {
  state.selectedShiftId = state.selectedShiftId === shiftId ? state.selectedShiftId : shiftId;
  if (state.shiftsReport) {
    renderShiftsReport(state.shiftsReport);
  }
  await loadShiftDetail(shiftId);
}

// ── Admin: User Management ─────────────────────────────────────────────────

let heartbeatTimer = null;
const HEARTBEAT_MS = 5 * 60 * 1000;

async function sendHeartbeat() {
  if (document.hidden || !state.currentUser) return;
  try {
    await api("/api/auth/heartbeat", { method: "POST" });
  } catch (_) {
    // Ignore transient heartbeat failures
  }
}

function initHeartbeat() {
  if (!state.currentUser) return;
  sendHeartbeat();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) sendHeartbeat();
  });
}

function populateAttendanceUserFilter(users) {
  const select = document.getElementById("attendance-user-filter");
  if (!select) return;
  const current = select.value;
  select.innerHTML =
    '<option value="">All users</option>' +
    users
      .map(
        (u) =>
          `<option value="${u.id}">${esc(u.display_name)} (${esc(ROLE_LABELS[u.role] || u.role)})</option>`
      )
      .join("");
  if ([...select.options].some((o) => o.value === current)) select.value = current;
}

async function loadAttendance() {
  const role = state.currentUser?.role;
  if (!state.currentUser || (role !== "admin" && role !== "supervisor")) return;

  const fromEl = document.getElementById("attendance-from");
  const toEl = document.getElementById("attendance-to");
  const today = new Date().toISOString().slice(0, 10);
  if (fromEl && !fromEl.value) fromEl.value = today;
  if (toEl && !toEl.value) toEl.value = today;

  showTableSkeleton("attendance-table-body", 7, 6);

  try {
    if (!state.users.length) {
      state.users = await api("/api/admin/users");
    }
    populateAttendanceUserFilter(state.users);

    const params = new URLSearchParams();
    if (fromEl?.value) params.set("from", fromEl.value);
    if (toEl?.value) params.set("to", toEl.value);
    const userId = document.getElementById("attendance-user-filter")?.value;
    if (userId) params.set("user_id", userId);

    const data = await api(`/api/admin/attendance?${params}`);
    renderAttendanceTable(data.sessions || []);
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderAttendanceTable(sessions) {
  const tbody = document.getElementById("attendance-table-body");
  if (!tbody) return;

  if (!sessions.length) {
    tbody.innerHTML = `<tr><td colspan="7">${emptyState(UI_ICONS.clock, "No sessions", "No login sessions in this period.", true)}</td></tr>`;
    return;
  }

  tbody.innerHTML = sessions
    .map((s) => {
      const status = s.is_active
        ? '<span class="badge badge-stock ok">Active</span>'
        : s.idle_before_logout
          ? '<span class="badge badge-stock low">Idle gap</span>'
          : `<span class="badge badge-muted">${esc(s.logout_reason || "Ended")}</span>`;
      return `
    <tr>
      <td><strong>${esc(s.display_name)}</strong><br><span class="text-muted">${esc(s.username)}</span></td>
      <td><span class="badge badge-category">${esc(ROLE_LABELS[s.role] || s.role)}</span></td>
      <td>${formatDate(s.logged_in_at)}</td>
      <td>${s.logged_out_at ? formatDate(s.logged_out_at) : "—"}</td>
      <td>${formatDate(s.last_heartbeat_at)}</td>
      <td>${esc(s.duration_label)}</td>
      <td>${status}</td>
    </tr>`;
    })
    .join("");
}

async function loadUsers() {
  if (!state.currentUser || state.currentUser.role !== "admin") return;

  showTableSkeleton("users-table-body", 5, 5);

  try {
    state.users = await api("/api/admin/users");
    renderUsersTable(state.users);
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderUsersTable(users) {
  const tbody = document.getElementById("users-table-body");
  if (!tbody) return;

  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No users yet</td></tr>`;
    return;
  }

  tbody.innerHTML = users
    .map((u) => {
      const isSelf = state.currentUser && u.id === state.currentUser.id;
      const roleLabel = ROLE_LABELS[u.role] || u.role;
      const statusClass = u.is_active ? "ok" : "out";
      const statusLabel = u.is_active ? "Active" : "Inactive";

      return `
    <tr>
      <td><strong>${esc(u.display_name)}</strong></td>
      <td>${esc(u.username)}</td>
      <td>${u.email ? esc(u.email) : '<span class="text-muted">—</span>'}</td>
      <td><span class="badge badge-category">${roleLabel}</span></td>
      <td><span class="badge badge-stock ${statusClass}">${statusLabel}</span></td>
      <td>
        <div class="action-group">
          <button class="btn-icon" title="Edit" onclick="openEditUser(${u.id})">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          ${
            isSelf
              ? ""
              : `<button class="btn-icon danger" title="Delete" onclick="openDeleteUser(${u.id}, '${escAttr(u.display_name)}')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>`
          }
        </div>
      </td>
    </tr>`;
    })
    .join("");
}

function openAddUser() {
  document.getElementById("user-modal-title").textContent = "Add Stock Manager";
  document.getElementById("user-form").reset();
  document.getElementById("user-id").value = "";
  document.getElementById("user-username").disabled = false;
  document.getElementById("user-password").required = true;
  document.getElementById("user-password-group").hidden = false;
  document.getElementById("user-pin").value = "";
  document.getElementById("user-active-group").hidden = true;
  document.getElementById("user-role").value = "seller";
  showModal("user-modal");
}

function openEditUser(id) {
  const user = state.users.find((u) => u.id === id);
  if (!user) return;

  document.getElementById("user-modal-title").textContent = "Edit User";
  document.getElementById("user-id").value = user.id;
  document.getElementById("user-display-name-input").value = user.display_name;
  document.getElementById("user-email-input").value = user.email || "";
  document.getElementById("user-username").value = user.username;
  document.getElementById("user-username").disabled = true;
  document.getElementById("user-password").value = "";
  document.getElementById("user-password").required = false;
  document.getElementById("user-password-group").hidden = false;
  document.getElementById("user-pin").value = "";
  document.getElementById("user-active-group").hidden = false;
  document.getElementById("user-role").value = user.role;
  document.getElementById("user-active").checked = user.is_active;
  showModal("user-modal");
}

function openDeleteUser(id, name) {
  state.deleteUserId = id;
  document.getElementById("delete-user-name").textContent = name;
  showModal("delete-user-modal");
}

async function saveUser(e) {
  e.preventDefault();
  const id = document.getElementById("user-id").value;
  const payload = {
    display_name: document.getElementById("user-display-name-input").value,
    email: document.getElementById("user-email-input").value,
    role: document.getElementById("user-role").value,
  };

  const password = document.getElementById("user-password").value;
  if (password) payload.password = password;
  const pin = document.getElementById("user-pin")?.value.trim() || "";
  if (pin) payload.pin = pin;

  try {
    if (id) {
      payload.is_active = document.getElementById("user-active").checked;
      await api(`/api/admin/users/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("User updated");
    } else {
      payload.username = document.getElementById("user-username").value;
      if (!password) {
        toast("Password is required for new users", "error");
        return;
      }
      await api("/api/admin/users", { method: "POST", body: JSON.stringify(payload) });
      toast("Stock manager created");
    }
    hideModal("user-modal");
    loadUsers();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function confirmDeleteUser() {
  try {
    await api(`/api/admin/users/${state.deleteUserId}`, { method: "DELETE" });
    toast("User deleted");
    hideModal("delete-user-modal");
    loadUsers();
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── Admin: Category Management ─────────────────────────────────────────────

async function loadCategoriesAdmin() {
  if (!state.currentUser || state.currentUser.role !== "admin") return;

  showTableSkeleton("categories-table-body", 3, 5);

  try {
    state.categories = await api("/api/categories");
    renderCategoriesTable(state.categories);
    populateCategorySelects();
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderCategoriesTable(categories) {
  const tbody = document.getElementById("categories-table-body");
  if (!tbody) return;

  if (!categories.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-state">No categories yet</td></tr>`;
    return;
  }

  tbody.innerHTML = categories
    .map(
      (c) => `
    <tr>
      <td>
        <strong>${esc(c.name)}</strong>
        ${c.is_default ? '<span class="text-muted" style="font-size:0.75rem;margin-left:0.35rem">Default</span>' : ""}
      </td>
      <td>${fmtNum.format(c.product_count)}</td>
      <td>${categoryStockTypeLabel(c.uses_cup_stock)}</td>
      <td>
        <div class="action-group">
          <button class="btn-icon" title="Edit" onclick="openEditCategory(${c.id})">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          ${
            c.is_default
              ? ""
              : `<button class="btn-icon danger" title="Delete" onclick="openDeleteCategory(${c.id}, '${escAttr(c.name)}')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>`
          }
        </div>
      </td>
    </tr>`
    )
    .join("");
}

function openAddCategory() {
  document.getElementById("category-modal-title").textContent = "Add Category";
  document.getElementById("category-form").reset();
  document.getElementById("category-id").value = "";
  document.getElementById("category-uses-cups").checked = false;
  document.getElementById("category-uses-cups").disabled = false;
  document.getElementById("category-stock-hint").textContent =
    "Leave unchecked for individual per-product stock.";
  showModal("category-modal");
}

function openEditCategory(id) {
  const category = state.categories.find((c) => c.id === id);
  if (!category) return;

  const isDefault = category.is_default || isDefaultCategory(category.name);
  document.getElementById("category-modal-title").textContent = "Edit Category";
  document.getElementById("category-id").value = category.id;
  document.getElementById("category-name").value = category.name;
  document.getElementById("category-uses-cups").checked = !!category.uses_cup_stock;
  document.getElementById("category-uses-cups").disabled = isDefault;
  document.getElementById("category-stock-hint").textContent = isDefault
    ? "Stock type is fixed for default categories."
    : "Leave unchecked for individual per-product stock.";
  showModal("category-modal");
}

function openDeleteCategory(id, name) {
  state.deleteCategoryId = id;
  document.getElementById("delete-category-name").textContent = name;
  showModal("delete-category-modal");
}

async function saveCategory(e) {
  e.preventDefault();
  const id = document.getElementById("category-id").value;
  const payload = {
    name: document.getElementById("category-name").value.trim(),
    uses_cup_stock: document.getElementById("category-uses-cups").checked,
  };

  try {
    if (id) {
      await api(`/api/admin/categories/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("Category updated");
    } else {
      await api("/api/admin/categories", { method: "POST", body: JSON.stringify(payload) });
      toast("Category added");
    }
    hideModal("category-modal");
    await loadCategoriesAdmin();
    await loadCategories();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function confirmDeleteCategory() {
  try {
    await api(`/api/admin/categories/${state.deleteCategoryId}`, { method: "DELETE" });
    toast("Category deleted");
    hideModal("delete-category-modal");
    await loadCategoriesAdmin();
    await loadCategories();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function performLogout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // redirect regardless
  }
  window.location.href = "/login";
}

async function logout() {
  if (isSeller()) {
    try {
      await refreshSellerShift();
    } catch {
      // If status check fails, still allow logout without blocking.
    }
    if (hasOpenShift()) {
      const msg = document.getElementById("logout-shift-message");
      const closeBtn = document.getElementById("logout-go-close-shift");
      if (canCloseShift()) {
        if (msg) {
          msg.textContent =
            "You still have an open shift and you are the supervisor. Close it so cash, MoMo, and Visa can be reconciled — or log out anyway if you will come back.";
        }
        if (closeBtn) closeBtn.hidden = false;
      } else {
        const lead = state.sellerShift?.shift?.supervisor_name;
        if (msg) {
          msg.textContent = lead
            ? `You are on an open shift${lead ? ` with ${lead}` : ""}. You can log out — a floor supervisor will close and reconcile when ready.`
            : "You are on an open shift as a seller. You can log out — a floor supervisor will close and reconcile when ready.";
        }
        if (closeBtn) closeBtn.hidden = true;
      }
      showModal("logout-shift-modal");
      return;
    }
  }
  await performLogout();
}

async function goCloseShiftFromLogout() {
  hideModal("logout-shift-modal");
  if (!canCloseShift()) {
    toast("Only a floor supervisor can close and reconcile.", "error");
    return;
  }
  pendingShiftUiPhase = "close";
  switchView("reconcile");
}

// ── Profile ────────────────────────────────────────────────────────────────

function syncProfileHero(user) {
  if (!user) return;
  const initial = (user.display_name || "?").charAt(0).toUpperCase();
  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val || "";
  };

  setText("profile-hero-avatar", initial);
  setText("profile-hero-name", user.display_name);
  setText("profile-hero-role", ROLE_LABELS[user.role] || user.role);
  setText("profile-hero-username", `@${user.username || ""}`);
  setText("profile-username-label", `@${user.username || ""}`);
  setText("profile-role-label-field", ROLE_LABELS[user.role] || user.role);

  const email = (user.email || "").trim();
  setText("profile-hero-email", email);
  const emailPill = document.getElementById("profile-hero-email-pill");
  if (emailPill) emailPill.hidden = !email;
}

function loadProfileView() {
  const user = state.currentUser;
  if (!user) return;

  const nameInput = document.getElementById("profile-display-name");
  const emailInput = document.getElementById("profile-email");
  if (nameInput) nameInput.value = user.display_name || "";
  if (emailInput) emailInput.value = user.email || "";

  syncProfileHero(user);
  document.getElementById("profile-password-form")?.reset();
  document.getElementById("profile-pin-form")?.reset();
  syncProfilePinForm(user);
}

function syncProfilePinForm(user) {
  const hasPin = !!user?.has_pin;
  const mustChange = !!user?.must_change_pin;
  const passwordGroup = document.getElementById("profile-current-password-group");
  const pinGroup = document.getElementById("profile-current-pin-group");
  const desc = document.getElementById("profile-pin-desc");
  const tip = document.getElementById("profile-pin-tip");
  const passwordInput = document.getElementById("profile-pin-password");
  const currentPinInput = document.getElementById("profile-current-pin");
  const banner = document.getElementById("profile-pin-force-banner");

  if (banner) banner.hidden = !mustChange;
  if (passwordGroup) passwordGroup.hidden = hasPin;
  if (pinGroup) pinGroup.hidden = !hasPin;
  if (passwordInput) passwordInput.required = !hasPin;
  if (currentPinInput) currentPinInput.required = hasPin;
  if (desc) {
    desc.textContent = mustChange
      ? "Choose your personal PIN now"
      : hasPin
        ? "Change your keypad PIN"
        : "Set a 4–6 digit PIN for quick sign-in";
  }
  if (tip) {
    tip.textContent = mustChange
      ? "Enter starter PIN 0000 as current PIN, then choose a unique 4–6 digit PIN only you will use."
      : hasPin
        ? "Enter your current PIN, then choose a new unique PIN."
        : "Confirm with your password, then choose a unique 4–6 digit PIN.";
  }
}

async function savePinFromProfile(e) {
  e.preventDefault();
  const pin = document.getElementById("profile-new-pin")?.value.trim() || "";
  const confirm = document.getElementById("profile-confirm-pin")?.value.trim() || "";
  if (pin !== confirm) {
    toast("PINs do not match", "error");
    return;
  }

  const hasPin = !!state.currentUser?.has_pin;
  const payload = { pin, confirm_pin: confirm };
  if (hasPin) {
    payload.current_pin = document.getElementById("profile-current-pin")?.value.trim() || "";
  } else {
    payload.current_password = document.getElementById("profile-pin-password")?.value || "";
  }

  const btn = document.getElementById("btn-save-pin");
  if (btn) btn.disabled = true;
  try {
    const data = await api("/api/auth/pin", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.currentUser = { ...state.currentUser, ...data.user };
    document.getElementById("profile-pin-form")?.reset();
    syncProfilePinForm(state.currentUser);
    toast(data.message || "PIN saved");
    if (!state.currentUser.must_change_pin) {
      const home = isSeller() ? "sell" : "dashboard";
      if (canAccessView(home)) switchView(home);
    }
  } catch (err) {
    toast(err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function updateUserPanel() {
  const user = state.currentUser;
  if (!user) return;
  const nameEl = document.getElementById("user-display-name");
  if (nameEl) nameEl.textContent = user.display_name || "";
  const avatarEl = document.getElementById("user-avatar");
  if (avatarEl) avatarEl.textContent = (user.display_name || "?").charAt(0).toUpperCase();
  syncProfileHero(user);
}

function previewProfileName() {
  const name = document.getElementById("profile-display-name")?.value.trim() || "";
  const heroName = document.getElementById("profile-hero-name");
  const heroAvatar = document.getElementById("profile-hero-avatar");
  if (heroName) heroName.textContent = name || state.currentUser?.display_name || "";
  if (heroAvatar) {
    heroAvatar.textContent = (name || state.currentUser?.display_name || "?").charAt(0).toUpperCase();
  }
}

async function saveProfile(e) {
  e.preventDefault();
  const btn = document.getElementById("btn-save-profile");
  const payload = {
    display_name: document.getElementById("profile-display-name").value.trim(),
    email: document.getElementById("profile-email").value.trim(),
  };
  if (btn) btn.disabled = true;
  try {
    const data = await api("/api/auth/profile", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    state.currentUser = { ...state.currentUser, ...data.user };
    updateUserPanel();
    toast("Profile updated");
  } catch (err) {
    toast(err.message, "error");
    syncProfileHero(state.currentUser);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function changePasswordFromProfile(e) {
  e.preventDefault();
  const current = document.getElementById("profile-current-password").value;
  const next = document.getElementById("profile-new-password").value;
  const confirm = document.getElementById("profile-confirm-password").value;

  if (next !== confirm) {
    toast("New passwords do not match", "error");
    return;
  }

  const btn = document.getElementById("btn-update-password");
  if (btn) btn.disabled = true;
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: current, new_password: next }),
    });
    document.getElementById("profile-password-form")?.reset();
    toast("Password updated");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function formatDateLabel(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-RW", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatRangeLabel(from, to) {
  if (from === to) return formatDateLabel(from);
  return `${formatDateLabel(from)} – ${formatDateLabel(to)}`;
}

function formatTime(iso) {
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-RW", { hour: "2-digit", minute: "2-digit" });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function typeBadge(type) {
  const labels = { sale: "Sale", restock: "Restock", adjustment: "Adjustment" };
  return `<span class="badge badge-${type}">${labels[type] || type}</span>`;
}

function formatTransactionQty(t) {
  if (t.type === "sale") return `−${t.quantity}`;
  if (t.type === "adjustment") return `${t.quantity > 0 ? "+" : ""}${t.quantity}`;
  return `+${t.quantity}`;
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-RW", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function escAttr(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

function showModal(id) {
  document.getElementById(id).hidden = false;
}

function hideModal(id) {
  document.getElementById(id).hidden = true;
}

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Restore persisted state before any rendering so cart/posMode/etc are ready
  const savedActiveView = restoreUIState();

  const dateEl = document.getElementById("current-date");
  if (dateEl) {
    dateEl.innerHTML = `${UI_ICONS.calendar}<span>${new Date().toLocaleDateString("en-RW", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    })}</span>`;
  }

  initNavigation();
  initSalesReports();
  initHistoryShiftFilters();
  initPosShortcuts();
  initCashNoteInputs();
  initHeartbeat();

  document.getElementById("btn-attendance-refresh")?.addEventListener("click", () => {
    loadAttendance().catch((e) => toast(e.message, "error"));
  });
  document.getElementById("attendance-user-filter")?.addEventListener("change", () => {
    loadAttendance().catch((e) => toast(e.message, "error"));
  });

  // Apply persisted posMode before any view renders
  applyRestoredPosMode();

  if (isSeller()) {
    loadCategories().then(() => {
      if (state.currentUser?.must_change_pin) {
        switchView("profile");
        toast("Set your personal PIN before using the till.", "error");
        return;
      }
      refreshSellerShift().then(() => {
        loadSellView().then(() => {
          applyRestoredPaymentMethod();
          // Navigate away from default sell view if user was on a different page
          if (savedActiveView && savedActiveView !== "sell" && canAccessView(savedActiveView)) {
            switchView(savedActiveView);
          }
        });
      });
    });
  } else {
    loadCategories()
      .then(() => {
        if (state.currentUser?.must_change_pin) {
          switchView("profile");
          toast("Set your personal PIN before continuing.", "error");
          return null;
        }
        return loadDashboard();
      })
      .then(() => {
        if (state.currentUser?.must_change_pin) return;
        applyRestoredPaymentMethod();
        // Navigate away from default dashboard if user was on a different page
        if (savedActiveView && savedActiveView !== "dashboard" && canAccessView(savedActiveView)) {
          switchView(savedActiveView);
        }
      });
  }

  window.addEventListener("beforeunload", saveUIState);

  document.getElementById("btn-quick-add-product")?.addEventListener("click", () => {
    switchView("products");
    setTimeout(openAddProduct, 150);
  });

  document.getElementById("btn-add-product")?.addEventListener("click", openAddProduct);
  document.getElementById("product-form")?.addEventListener("submit", saveProduct);
  document.getElementById("confirm-delete")?.addEventListener("click", confirmDelete);
  document.getElementById("btn-add-ingredient")?.addEventListener("click", openAddIngredient);
  document.getElementById("ingredient-form")?.addEventListener("submit", saveIngredient);
  document.getElementById("confirm-delete-ingredient")?.addEventListener("click", confirmDeleteIngredient);
  document.getElementById("product-uses-recipe")?.addEventListener("change", updateProductStockFields);
  document.getElementById("btn-add-recipe-line")?.addEventListener("click", addRecipeLine);
  document.getElementById("product-price")?.addEventListener("input", updateRecipeCostPreview);
  document.getElementById("recipe-lines")?.addEventListener("change", (e) => {
    if (e.target.matches("[data-recipe-field]")) {
      syncRecipeDraftFromDom();
      if (e.target.dataset.recipeField === "ingredient_id") renderRecipeLines();
      else updateRecipeCostPreview();
    }
  });
  document.getElementById("recipe-lines")?.addEventListener("input", (e) => {
    if (e.target.matches('[data-recipe-field="qty_per_unit"]')) {
      updateRecipeCostPreview();
    }
  });
  document.getElementById("recipe-lines")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove-recipe-line]");
    if (!btn) return;
    removeRecipeLine(Number(btn.dataset.removeRecipeLine));
  });

  const debouncedLoadProducts = debounce(loadProducts, 300);
  document.getElementById("product-search")?.addEventListener("input", () => {
    showTableSkeleton("products-table-body", 8);
    debouncedLoadProducts();
  });
  document.getElementById("product-category-filter")?.addEventListener("change", loadProducts);
  document.getElementById("low-stock-filter")?.addEventListener("change", loadProducts);
  const debouncedLoadIngredients = debounce(loadIngredients, 300);
  document.getElementById("ingredient-search")?.addEventListener("input", () => {
    showTableSkeleton("ingredients-table-body", 7);
    debouncedLoadIngredients();
  });
  document.getElementById("ingredient-low-stock-filter")?.addEventListener("change", loadIngredients);
  document.getElementById("product-name")?.addEventListener("input", () => {
    syncCategoryFromProductName();
    updateProductStockFields();
  });
  document.getElementById("product-name")?.addEventListener("change", () => {
    syncCategoryFromProductName();
    updateProductStockFields();
  });
  document.getElementById("product-category")?.addEventListener("change", updateProductStockFields);

  document.getElementById("cup-restock-form")?.addEventListener("submit", submitCupRestock);
  document.getElementById("ingredient-restock-form")?.addEventListener("submit", submitIngredientRestock);
  document.getElementById("ingredient-restock-select")?.addEventListener("change", updateIngredientRestockPreview);
  document.getElementById("ingredient-restock-quantity")?.addEventListener("input", updateIngredientRestockPreview);
  document.getElementById("ingredient-restock-cost")?.addEventListener("input", (e) => {
    e.target.dataset.touched = "1";
  });
  document.getElementById("cup-restock-quantity")?.addEventListener("input", updateCupRestockPreview);
  document.getElementById("cup-qty-minus")?.addEventListener("click", () => {
    const input = document.getElementById("cup-restock-quantity");
    input.value = Math.max(1, (parseInt(input.value, 10) || 1) - 1);
    updateCupRestockPreview();
  });
  document.getElementById("cup-qty-plus")?.addEventListener("click", () => {
    const input = document.getElementById("cup-restock-quantity");
    input.value = (parseInt(input.value, 10) || 1) + 1;
    updateCupRestockPreview();
  });
  document.querySelectorAll(".cup-qty-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("cup-restock-quantity").value = btn.dataset.qty;
      updateCupRestockPreview();
    });
  });

  document.getElementById("btn-pos-mode")?.addEventListener("click", togglePosMode);

  document.getElementById("sell-search")?.addEventListener("input", (e) => {
    state.sellSearch = e.target.value;
    renderQuickPick();
  });

  document.getElementById("sell-product").addEventListener("change", updateSellPreview);
  document.getElementById("qty-minus").addEventListener("click", () => adjustQty(-1));
  document.getElementById("qty-plus").addEventListener("click", () => adjustQty(1));
  document.getElementById("add-to-cart-form").addEventListener("submit", submitAddToCart);
  initPaymentMethods();
  initSellTableSelect();
  document.getElementById("btn-complete-sale").addEventListener("click", completeCheckout);
  document.getElementById("btn-clear-cart").addEventListener("click", clearCart);
  document.getElementById("btn-refresh-activity")?.addEventListener("click", () => {
    loadDashboard().catch((err) => toast(err.message, "error"));
  });
  document.getElementById("dashboard-activity-body")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-settle-credit]");
    if (!btn) return;
    openSettleCreditModal(btn.dataset.settleCredit);
  });
  document.querySelectorAll("#settle-payment-methods .payment-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#settle-payment-methods .payment-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      pendingSettleMethod = chip.dataset.method;
    });
  });
  document.getElementById("settle-credit-form")?.addEventListener("submit", submitSettleCredit);
  document.getElementById("shift-start-form")?.addEventListener("submit", submitStartShift);
  document.getElementById("shift-close-form")?.addEventListener("submit", submitCloseShift);
  document.getElementById("btn-new-shift")?.addEventListener("click", () => {
    startNewShiftFromResult().catch((err) => toast(err.message, "error"));
  });
  document.getElementById("btn-sell-start-shift")?.addEventListener("click", () => {
    startShiftFromSell().catch((err) => toast(err.message, "error"));
  });
  document.getElementById("btn-show-close")?.addEventListener("click", async () => {
    try {
      await refreshSellerShift();
    } catch (err) {
      toast(err.message, "error");
    }
    if (!canCloseShift()) {
      toast("Only a floor supervisor can close and reconcile.", "error");
      renderShiftOpenPhase();
      return;
    }
    setShiftUiPhase("close");
    document.getElementById("cash-note-5000")?.focus();
  });
  document.getElementById("btn-back-to-sell")?.addEventListener("click", () => setShiftUiPhase("sell"));

  document.getElementById("void-sale-form")?.addEventListener("submit", submitVoidSale);
  document.getElementById("cart-remove-form")?.addEventListener("submit", submitCartRemove);
  const cartRemoveModal = document.getElementById("cart-remove-modal");
  cartRemoveModal?.addEventListener("click", (e) => {
    if (e.target === cartRemoveModal || e.target.closest("[data-close-modal]")) {
      cancelCartRemoval();
    }
  });
  document.getElementById("btn-print-invoice")?.addEventListener("click", printInvoice);

  document.getElementById("restock-form")?.addEventListener("submit", submitRestock);
  document.getElementById("adjust-form")?.addEventListener("submit", submitAdjust);
  document.getElementById("lots-pool-filter")?.addEventListener("change", loadLotsPanel);
  document.getElementById("lots-refresh-btn")?.addEventListener("click", loadLotsPanel);

  document.getElementById("history-type-filter").addEventListener("change", loadHistory);
  document.getElementById("history-seller-filter")?.addEventListener("change", loadHistory);
  document.getElementById("history-category-filter")?.addEventListener("change", loadHistory);
  document.getElementById("sales-seller-filter")?.addEventListener("change", () => {
    const from = document.getElementById("sales-from")?.value;
    const to = document.getElementById("sales-to")?.value;
    state.selectedShiftId = null;
    loadSalesViewData(from, to);
  });

  document.querySelectorAll("#history-filter-chips .filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#history-filter-chips .filter-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      document.getElementById("history-type-filter").value = chip.dataset.type;
      loadHistory();
    });
  });

  document.getElementById("btn-logout")?.addEventListener("click", logout);
  document.getElementById("logout-go-close-shift")?.addEventListener("click", goCloseShiftFromLogout);
  document.getElementById("logout-anyway")?.addEventListener("click", () => {
    hideModal("logout-shift-modal");
    performLogout();
  });
  document.getElementById("btn-open-profile")?.addEventListener("click", () => switchView("profile"));
  document.getElementById("profile-form")?.addEventListener("submit", saveProfile);
  document.getElementById("profile-password-form")?.addEventListener("submit", changePasswordFromProfile);
  document.getElementById("profile-pin-form")?.addEventListener("submit", savePinFromProfile);
  document.getElementById("profile-display-name")?.addEventListener("input", previewProfileName);
  document.getElementById("btn-add-user")?.addEventListener("click", openAddUser);
  document.getElementById("user-form")?.addEventListener("submit", saveUser);
  document.getElementById("confirm-delete-user")?.addEventListener("click", confirmDeleteUser);
  document.getElementById("btn-add-category")?.addEventListener("click", openAddCategory);
  document.getElementById("category-form")?.addEventListener("submit", saveCategory);
  document.getElementById("confirm-delete-category")?.addEventListener("click", confirmDeleteCategory);

  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest(".modal-overlay").hidden = true;
    });
  });

  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.hidden = true;
    });
  });

  document.getElementById("business-switcher-trigger")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!document.getElementById("brand-business")?.classList.contains("is-switchable")) {
      return;
    }
    toggleBusinessSwitcher();
  });
  document.getElementById("brand-business")?.addEventListener("click", (e) => {
    const option = e.target.closest("[data-business-id]");
    if (!option) return;
    e.stopPropagation();
    const id = option.getAttribute("data-business-id");
    closeBusinessSwitcher();
    if (!id || String(state.currentBusiness?.id) === String(id)) return;
    switchBusiness(id);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#brand-business")) closeBusinessSwitcher();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeBusinessSwitcher();
  });
  renderBusinessSwitcher(state.memberships, state.currentBusiness?.id);
  applyBusinessBranding(state.currentBusiness);
  document.getElementById("btn-add-business")?.addEventListener("click", openAddBusiness);
  document.getElementById("business-form")?.addEventListener("submit", saveBusiness);
  document.getElementById("business-edit-form")?.addEventListener("submit", saveBusinessEdit);
  document.getElementById("confirm-delete-business")?.addEventListener("click", confirmDeleteBusiness);
  document.getElementById("branding-colors-form")?.addEventListener("submit", saveBrandingColors);
  document.getElementById("btn-branding-reset-colors")?.addEventListener("click", resetBrandingColors);
  document.getElementById("btn-upload-logo")?.addEventListener("click", uploadBusinessLogo);
  document.getElementById("btn-remove-logo")?.addEventListener("click", removeBusinessLogo);
  document.getElementById("branding-logo-file")?.addEventListener("change", onBrandingLogoFileChange);
  bindBrandingColorPair("branding-primary", "branding-primary-hex");
  bindBrandingColorPair("branding-accent", "branding-accent-hex");
  document.getElementById("btn-activity-refresh")?.addEventListener("click", loadActivityLogs);
  document.getElementById("activity-from")?.addEventListener("change", loadActivityLogs);
  document.getElementById("activity-to")?.addEventListener("change", loadActivityLogs);
  document.getElementById("activity-action-filter")?.addEventListener("change", loadActivityLogs);
  document.getElementById("activity-user-filter")?.addEventListener("change", loadActivityLogs);
});

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Expose for inline handlers
window.selectRestockProduct = selectRestockProduct;
window.openEditProduct = openEditProduct;
window.openDeleteProduct = openDeleteProduct;
window.quickSell = quickSell;
window.addToCart = addToCart;
window.updateCartItemQty = updateCartItemQty;
window.removeFromCart = removeFromCart;
window.selectSalesDate = selectSalesDate;
window.selectShift = selectShift;
window.selectHistoryShift = selectHistoryShift;
window.openVoidSaleModal = openVoidSaleModal;
window.selectSellCategory = selectSellCategory;
window.openEditUser = openEditUser;
window.openDeleteUser = openDeleteUser;
window.openEditCategory = openEditCategory;
window.openDeleteCategory = openDeleteCategory;
window.toggleBusinessActive = toggleBusinessActive;
window.openAddBusiness = openAddBusiness;
window.openEditBusiness = openEditBusiness;
window.openDeleteBusiness = openDeleteBusiness;
