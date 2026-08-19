/* =============================================================================
   BUDGET TRACKER
   -----------------------------------------------------------------------------
   Frontend logic for the Budget Tracker tool. Replaces the old Excel
   bill-manager workbook: a running ledger of income + fluctuating expenses,
   plus recurring bill templates that track a single "current due" date and
   roll forward into a paid-instance history once settled.

   Architecture notes:
     • The entire dataset is one JSON blob persisted via save_budget_data /
       load_budget_data. Same shape on disk as in memory, no per-table files.
     • Categories, income sources, and expense sources share an
       {id, name, status} shape. "Retired" items stay referenced by historical
       entries but drop out of active pickers/quick-add.
     • Recurring bills carry exactly one live `nextDue` date. The "current
       active instance". Paying a bill records a BillInstance (historical,
       anchored to the due date it was for) and advances `nextDue`.
     • Bill-row computation (getBillRowsForRange) implements the agreed model:
       browsing month M shows paid instances whose due date falls in M; only
       the CURRENT real-world month additionally shows each active bill's live
       `nextDue` as "pending" (or "overdue" if nextDue precedes this month's
       start), so a bill due next month but paid early still surfaces today,
       and once paid it settles into its actual due month's history.

   Rust commands used: save_budget_data, load_budget_data
============================================================================= */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { flash, escapeHtml, setToolAttention } from "../shell";
import {
  DAY_MS,
  isReminderDue,
  normalizeMonthDays,
  parseMonthDaysInput,
} from "../reminder-schedule";
import { Modal, ModalTabs } from "../modal";

/* =============================================================================
   TYPES
============================================================================= */

export type Status = "active" | "retired";

export type Category = {
  id: string;
  name: string;
  status: Status;
  excludeFromCharts?: boolean;
  /** Whether a monthly spending "Threshold" (budget) is set for this category. */
  thresholdEnabled?: boolean;
  /** Spending limit for this category over a calendar month. */
  threshold?: number | null;
  /** % of threshold at which the progress bar turns from green to yellow. */
  thresholdWarningPct?: number | null;
};

export type IncomeSource = {
  id: string;
  name: string;
  status: Status;
  excludeFromCharts?: boolean;
  /** Whether a monthly earnings "Expectation" is set for this source. */
  expectationEnabled?: boolean;
  /** Expected earnings for this source over a calendar month. */
  expectation?: number | null;
};

export type ExpenseSource = {
  id: string;
  name: string;
  status: Status;
  excludeFromCharts?: boolean;
  /** Whether a monthly spending "Threshold" (budget) is set for this source. */
  thresholdEnabled?: boolean;
  /** Spending limit for this source over a calendar month. */
  threshold?: number | null;
  /** % of threshold at which the progress bar turns from green to yellow. */
  thresholdWarningPct?: number | null;
};

export type RecurrenceUnit = "days" | "weeks" | "months" | "years";

export type Recurrence = {
  /** How many units between occurrences (e.g. 3 + "months" = quarterly). */
  interval: number;
  unit: RecurrenceUnit;
};

export const RECURRENCE_UNIT_LABELS: Record<
  RecurrenceUnit,
  { singular: string; plural: string }
> = {
  days: { singular: "Day", plural: "Days" },
  weeks: { singular: "Week", plural: "Weeks" },
  months: { singular: "Month", plural: "Months" },
  years: { singular: "Year", plural: "Years" },
};

/** Human-readable summary, e.g. "Every 3 Months" or "Every Year". */
export function describeRecurrence(r: Recurrence): string {
  const labels = RECURRENCE_UNIT_LABELS[r.unit];
  const label = r.interval === 1 ? labels.singular : labels.plural;
  return `Every ${r.interval} ${label}`;
}

/**
 * Display text for a bill's planned amount. Variable bills can still carry an
 * estimate (shown with a "~" to mark it as approximate), "amount === null"
 * means "no estimate given", independent of Fixed vs Variable.
 */
export function formatBillAmount(bill: RecurringBill): string {
  if (bill.amount === null) {
    return bill.billType === "variable" ? "Variable" : "—";
  }
  const formatted = formatCurrency(bill.amount);
  return bill.billType === "variable" ? `~${formatted}` : formatted;
}

export type BillType = "fixed" | "variable";

export type RecurringBill = {
  id: string;
  name: string;
  billType: BillType;
  /** Planned amount. Null for Variable bills whose amount isn't known ahead of time. */
  amount: number | null;
  recurrence: Recurrence;
  /** The current unpaid due date. The single "active instance" for this bill. */
  nextDue: string; // YYYY-MM-DD
  autopay: boolean;
  payMethod: string;
  status: Status;
  notes: string;
};

/** A historical record of a paid recurring bill, anchored to the due date it settles. */
export type BillInstance = {
  id: string;
  billId: string;
  dueDate: string; // YYYY-MM-DD: the due date this payment settles
  /** Snapshot of the planned amount at the time of payment (for Planned vs Actual stats). */
  plannedAmount: number | null;
  actualAmount: number;
  paidDate: string; // YYYY-MM-DD
  cleared: boolean;
  /** Date the payment cleared the account. Only set when cleared === true. */
  clearedDate: string; // YYYY-MM-DD or ""
  notes: string;
};

export type IncomeEntry = {
  id: string;
  date: string; // YYYY-MM-DD
  sourceId: string;
  expected: number;
  actual: number;
  notes: string;
};

export type FluctuatingExpense = {
  id: string;
  date: string; // YYYY-MM-DD
  categoryId: string;
  description: string;
  amount: number;
  notes: string;
};

export type BudgetData = {
  categories: Category[];
  incomeSources: IncomeSource[];
  expenseSources: ExpenseSource[];
  recurringBills: RecurringBill[];
  billInstances: BillInstance[];
  incomeEntries: IncomeEntry[];
  fluctuatingExpenses: FluctuatingExpense[];
};

/**
 * Which top-level BudgetData fields live in which on-disk file. saveToDisk()
 * builds each file's payload from these two lists instead of separate
 * hand-written object literals, add a new array to BudgetData, and the
 * compile-time check right below will fail the build if you forget to add
 * its name to exactly one of these lists too. Without that check, a forgotten
 * field would still work fine for the rest of the session (it's on `data`,
 * every render function sees it) and then silently fail to persist at all,
 * gone on next launch, no error, nothing to point at.
 */
const ENTITY_FIELDS = ["categories", "incomeSources", "expenseSources", "recurringBills"] as const;
const ENTRY_FIELDS = ["billInstances", "incomeEntries", "fluctuatingExpenses"] as const;

type _CoveredFields = (typeof ENTITY_FIELDS)[number] | (typeof ENTRY_FIELDS)[number];
// If this line shows a type error, a field exists on BudgetData that isn't
// in ENTITY_FIELDS or ENTRY_FIELDS above, add it to one of them before
// doing anything else, or it will never be written to disk.
type _AssertAllBudgetFieldsRouted = keyof BudgetData extends _CoveredFields ? true : never;
const _assertAllBudgetFieldsRouted: _AssertAllBudgetFieldsRouted = true;

function pickFields<K extends keyof BudgetData>(d: BudgetData, fields: readonly K[]): Pick<BudgetData, K> {
  const out = {} as Pick<BudgetData, K>;
  for (const f of fields) out[f] = d[f];
  return out;
}

function emptyData(): BudgetData {
  return {
    categories: [],
    incomeSources: [],
    expenseSources: [],
    recurringBills: [],
    billInstances: [],
    incomeEntries: [],
    fluctuatingExpenses: [],
  };
}

/* =============================================================================
   MODULE-LEVEL STATE
============================================================================= */

let data: BudgetData = emptyData();

// View mode and range state
type ViewMode = "day" | "week" | "month" | "year";
let viewMode: ViewMode = "month";
let viewYear = 0;
let viewMonth = 0; // 0-indexed; meaningful in month mode
let viewDay = 1; // day-of-month; meaningful in day mode
let viewWeekStart = ""; // YYYY-MM-DD of Monday; meaningful in week mode
let viewStart: string = "";
let viewEnd: string = "";

let saveTimer: number | null = null;
const SAVE_DEBOUNCE_MS = 400;

/* =============================================================================
   ENCRYPTION STATE
   sessionPassword is held in memory only, never written anywhere.
   It is cleared when the tool is locked (session-unlock mode only).
============================================================================= */

let encryptionEnabled = false;
let sessionUnlockMode = false;  // true = auth once per session; false = auth on every tool entry
// Set on every successful auth, in BOTH modes. It gates re-entry only when
// sessionUnlockMode is true, but the OS-session-lock listener reads it in the
// other mode too, to tell "re-auth mode with a live authenticated session"
// apart from "already locked" (see the session-lock-changed listener).
let sessionUnlocked = false;
let sessionPassword = "";       // in-memory only; "" when not authenticated

/* =============================================================================
   ID GENERATION
============================================================================= */

function makeId(): string {
  return crypto.randomUUID();
}

/* =============================================================================
   DATE HELPERS
============================================================================= */

function localDateString(d: Date): string {
  return d.toLocaleDateString("en-CA"); // YYYY-MM-DD
}

function today(): string {
  return localDateString(new Date());
}

function parseDate(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00");
}

/**
 * True if dateStr falls within [start, end]. An empty start/end means
 * unbounded on that side (matches the "All" preset).
 */
function inRange(dateStr: string, start: string, end: string): boolean {
  if (start && dateStr < start) return false;
  if (end && dateStr > end) return false;
  return true;
}

/** True if today falls within [start, end], with the same unbounded-on-empty rule. */
function todayInRange(start: string, end: string): boolean {
  return inRange(today(), start, end);
}

/**
 * Advances a due date by one cycle of the given recurrence.
 * Used to compute the suggested next due date when a bill is marked paid.
 * The result is shown for review/edit, never committed silently.
 */
export function advanceDate(dateStr: string, recurrence: Recurrence): string {
  const d = parseDate(dateStr);
  const n = Math.max(1, Math.floor(recurrence.interval) || 1);
  switch (recurrence.unit) {
    case "days":
      d.setDate(d.getDate() + n);
      break;
    case "weeks":
      d.setDate(d.getDate() + n * 7);
      break;
    case "months":
      d.setMonth(d.getMonth() + n);
      break;
    case "years":
      d.setFullYear(d.getFullYear() + n);
      break;
  }
  return localDateString(d);
}

/* =============================================================================
   PERSISTENCE
============================================================================= */

/* =============================================================================
   PERSISTENCE: migration, sanitization, and blast-door error handling
   -----------------------------------------------------------------------------
   Schema changes happen regularly during development. Rather than crashing
   (and hiding the window because initBudget throws before window.show()), we:

     1. Try to parse and migrate the stored blob.
     2. Sanitize every collection: unknown keys are ignored, missing arrays
        default to [], and per-record fields are coerced to safe defaults so
        downstream rendering never hits a null it didn't expect.
     3. If anything at any step fails, fall back to empty data and record the
        reason. After init, the UI shows an inline warning that lets the user
        acknowledge and optionally wipe the bad file. The window always opens.
============================================================================= */

/** Maps the old fixed recurrence strings to the new {interval, unit} shape. */
const LEGACY_RECURRENCE: Record<string, Recurrence> = {
  monthly: { interval: 1, unit: "months" },
  quarterly: { interval: 3, unit: "months" },
  annually: { interval: 1, unit: "years" },
  decennially: { interval: 10, unit: "years" },
};

/** Coerces any value to an array, returning [] for anything non-array. */
function toArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Coerces any value to a string, returning the fallback for non-strings. */
function toStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Coerces any value to a boolean. */
function toBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** Coerces any value to a number, returning fallback for non-finite results. */
function toNum(v: unknown, fallback: number | null): number | null {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

/** Coerces any value to a non-null number, returning fallback for non-finite results. */
function toNumReq(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

/** Parses a positive (>0) finite decimal from a raw input string, or null if invalid. */
function parsePositiveDecimal(raw: string): number | null {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parses a positive (>0) finite decimal in (0, 100], or null if invalid. */
function parseWarningPct(raw: string): number | null {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

/** Ensures a recurrence value is the current {interval, unit} shape. */
function sanitizeRecurrence(r: unknown): Recurrence {
  if (typeof r === "string" && r in LEGACY_RECURRENCE)
    return LEGACY_RECURRENCE[r];
  if (r && typeof r === "object") {
    const ro = r as Record<string, unknown>;
    const interval = Math.max(1, Math.floor(toNumReq(ro.interval, 1)));
    const unit = (
      ["days", "weeks", "months", "years"].includes(String(ro.unit))
        ? ro.unit
        : "months"
    ) as RecurrenceUnit;
    return { interval, unit };
  }
  return { interval: 1, unit: "months" };
}

function sanitizeStatus(v: unknown): Status {
  return v === "retired" ? "retired" : "active";
}

function sanitizeCategory(raw: unknown): Category | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = toStr(r.id);
  if (!id) return null;
  return {
    id,
    name: toStr(r.name, "(unnamed)"),
    status: sanitizeStatus(r.status),
    excludeFromCharts: toBool(r.excludeFromCharts),
    thresholdEnabled: toBool(r.thresholdEnabled),
    threshold: toNum(r.threshold, null),
    thresholdWarningPct: toNum(r.thresholdWarningPct, 80),
  };
}

function sanitizeIncomeSource(raw: unknown): IncomeSource | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = toStr(r.id);
  if (!id) return null;
  return {
    id,
    name: toStr(r.name, "(unnamed)"),
    status: sanitizeStatus(r.status),
    excludeFromCharts: toBool(r.excludeFromCharts),
    expectationEnabled: toBool(r.expectationEnabled),
    expectation: toNum(r.expectation, null),
  };
}

function sanitizeExpenseSource(raw: unknown): ExpenseSource | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = toStr(r.id);
  if (!id) return null;
  return {
    id,
    name: toStr(r.name, "(unnamed)"),
    status: sanitizeStatus(r.status),
    excludeFromCharts: toBool(r.excludeFromCharts),
    thresholdEnabled: toBool(r.thresholdEnabled),
    threshold: toNum(r.threshold, null),
    thresholdWarningPct: toNum(r.thresholdWarningPct, 80),
  };
}

function sanitizeRecurringBill(raw: unknown): RecurringBill | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = toStr(r.id);
  if (!id) return null;
  return {
    id,
    name: toStr(r.name, "(unnamed)"),
    billType: r.billType === "variable" ? "variable" : "fixed",
    amount: toNum(r.amount, null),
    recurrence: sanitizeRecurrence(r.recurrence),
    nextDue: toStr(r.nextDue) || localDateString(new Date()),
    autopay: toBool(r.autopay),
    payMethod: toStr(r.payMethod),
    status: sanitizeStatus(r.status),
    notes: toStr(r.notes),
  };
}

function sanitizeBillInstance(raw: unknown): BillInstance | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = toStr(r.id);
  const billId = toStr(r.billId);
  if (!id || !billId) return null;
  return {
    id,
    billId,
    dueDate: toStr(r.dueDate) || localDateString(new Date()),
    plannedAmount: toNum(r.plannedAmount, null),
    actualAmount: toNumReq(r.actualAmount),
    paidDate: toStr(r.paidDate) || localDateString(new Date()),
    cleared: toBool(r.cleared),
    clearedDate: toStr(r.clearedDate),
    notes: toStr(r.notes),
  };
}

function sanitizeIncomeEntry(raw: unknown): IncomeEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = toStr(r.id);
  if (!id) return null;
  return {
    id,
    date: toStr(r.date) || localDateString(new Date()),
    sourceId: toStr(r.sourceId),
    expected: toNumReq(r.expected),
    actual: toNumReq(r.actual),
    notes: toStr(r.notes),
  };
}

function sanitizeFluctuatingExpense(raw: unknown): FluctuatingExpense | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = toStr(r.id);
  if (!id) return null;
  return {
    id,
    date: toStr(r.date) || localDateString(new Date()),
    categoryId: toStr(r.categoryId),
    description: toStr(r.description),
    amount: toNumReq(r.amount),
    notes: toStr(r.notes),
  };
}

/**
 * Parses raw JSON from disk into a validated BudgetData.
 * Handles renamed fields (descriptions -> expenseSources), missing collections,
 * wrong types, and any other shape mismatch the tool has ever produced.
 */
function sanitizeData(raw: unknown): BudgetData {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;

  // "descriptions" was the old name for expenseSources, merge both if present
  const expenseSourceRaw = Array.isArray(r.expenseSources)
    ? r.expenseSources
    : Array.isArray(r.descriptions)
      ? r.descriptions
      : [];

  return {
    categories: toArray<unknown>(r.categories)
      .map(sanitizeCategory)
      .filter((x): x is Category => x !== null),
    incomeSources: toArray<unknown>(r.incomeSources)
      .map(sanitizeIncomeSource)
      .filter((x): x is IncomeSource => x !== null),
    expenseSources: expenseSourceRaw
      .map(sanitizeExpenseSource)
      .filter((x): x is ExpenseSource => x !== null),
    recurringBills: toArray<unknown>(r.recurringBills)
      .map(sanitizeRecurringBill)
      .filter((x): x is RecurringBill => x !== null),
    billInstances: toArray<unknown>(r.billInstances)
      .map(sanitizeBillInstance)
      .filter((x): x is BillInstance => x !== null),
    incomeEntries: toArray<unknown>(r.incomeEntries)
      .map(sanitizeIncomeEntry)
      .filter((x): x is IncomeEntry => x !== null),
    fluctuatingExpenses: toArray<unknown>(r.fluctuatingExpenses)
      .map(sanitizeFluctuatingExpense)
      .filter((x): x is FluctuatingExpense => x !== null),
  };
}

/**
 * What went wrong on load, if anything. Set by loadFromDisk(), read by
 * initBudget() after the window is shown to decide whether to warn the user.
 */
let loadError: string | null = null;

async function loadFromDisk(): Promise<void> {
  loadError = null;
  try {
    let entitiesRaw: string;
    let entriesRaw: string;
    if (encryptionEnabled) {
      // Decrypt into memory, plaintext never touches disk
      entitiesRaw = await invoke<string>("budget_decrypt_entities_to_memory", { password: sessionPassword });
      entriesRaw = await invoke<string>("budget_decrypt_to_memory", { password: sessionPassword });
    } else {
      entitiesRaw = await invoke<string>("load_budget_entities");
      entriesRaw = await invoke<string>("load_budget_data");
    }

    const entitiesEmpty = !entitiesRaw || entitiesRaw.trim() === "" || entitiesRaw.trim() === "{}";
    const entriesEmpty = !entriesRaw || entriesRaw.trim() === "" || entriesRaw.trim() === "{}";
    // Empty on both sides / first run, backend returns "{}" for each, which is fine
    if (entitiesEmpty && entriesEmpty) {
      data = emptyData();
      return;
    }

    let entitiesParsed: unknown = {};
    let entriesParsed: unknown = {};
    try {
      if (!entitiesEmpty) entitiesParsed = JSON.parse(entitiesRaw);
      if (!entriesEmpty) entriesParsed = JSON.parse(entriesRaw);
    } catch (e) {
      loadError = `The saved data file could not be parsed as JSON: ${e}`;
      data = emptyData();
      return;
    }

    // The two files' field sets never overlap (categories/incomeSources/
    // expenseSources/recurringBills vs. billInstances/incomeEntries/
    // fluctuatingExpenses), sanitizeData validates and defaults each field
    // independently regardless of which file it came from, so a plain merge
    // here is enough; nothing downstream needs to know there were two files.
    data = sanitizeData({
      ...(entitiesParsed as Record<string, unknown>),
      ...(entriesParsed as Record<string, unknown>),
    });
  } catch (e) {
    loadError = `Could not read the data file: ${e}`;
    data = emptyData();
  }
}

async function saveToDisk(): Promise<void> {
  const entities = JSON.stringify(pickFields(data, ENTITY_FIELDS));
  const entries = JSON.stringify(pickFields(data, ENTRY_FIELDS));

  // Snapshot the password NOW, synchronously. The second invoke below runs
  // after an await, and a flush-then-relock sequence may have blanked
  // sessionPassword by then. Everything this function needs is captured
  // before the first await, so callers may safely reset module state the
  // moment the call returns (they don't have to wait for the promise).
  const password = sessionPassword;

  if (encryptionEnabled) {
    // A queued save can outlive the session that scheduled it (tool re-lock,
    // navigating away, disabling encryption). If that happens, the password
    // was already cleared before this ran, never send an empty password to
    // the backend, since that would silently re-encrypt the file under the
    // wrong key. (The Rust side rejects this too; this is the first line of
    // defense.)
    if (!password) return;
    await invoke("budget_save_entities_encrypted", { password, data: entities });
    await invoke("budget_save_encrypted", { password, data: entries });
  } else {
    await invoke("save_budget_entities", { data: entities });
    await invoke("save_budget_data", { data: entries });
  }
}

/** Debounced save, call after any mutation.
 *  The saveToDisk() promise MUST be caught here: this fires from a timer, so
 *  a rejection has no caller to bubble to, a disk-full or locked-file error
 *  would otherwise vanish as an unhandled rejection while the user keeps
 *  editing, believing everything is persisting. */
function queueSave(): void {
  // Stamped here rather than in saveToDisk(): this is the point where the user
  // actually changed something, and it's the one call every mutation path
  // already goes through. saveToDisk() also runs from the flush path, which
  // would re-stamp an edit that was already counted.
  markBudgetUpdated();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    saveToDisk().catch((e) => {
      flash(`Failed to save budget data: ${e}`, "error", 8000);
    });
  }, SAVE_DEBOUNCE_MS);
}

/**
 * If an edit is still sitting in the debounce queue, writes it NOW instead
 * of letting it be discarded. Must be called BEFORE clearing sessionPassword
 * or resetting `data` (tool re-lock, disabling encryption, navigating away,
 * quitting), saveToDisk() captures everything it needs synchronously, so
 * callers may reset state immediately after this returns without awaiting
 * the promise. Safe to call at any time: a no-op when nothing is queued.
 */
async function flushQueuedSave(): Promise<void> {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await saveToDisk();
  } catch (e) {
    flash(`Failed to save budget data: ${e}`, "error", 8000);
  }
}

/**
 * Called by shell.ts when the user navigates AWAY from the Budget tool, and
 * on app quit, flushes any pending debounced save so an edit made within
 * SAVE_DEBOUNCE_MS of leaving the tool isn't silently lost.
 */
export async function onBudgetToolExit(): Promise<void> {
  await flushQueuedSave();
}

/* =============================================================================
   LOOKUP HELPERS: status-aware
============================================================================= */

export function getActiveCategories(): Category[] {
  return data.categories.filter((c) => c.status === "active");
}

export function getActiveIncomeSources(): IncomeSource[] {
  return data.incomeSources.filter((s) => s.status === "active");
}

export function getActiveExpenseSources(): ExpenseSource[] {
  return data.expenseSources.filter((d) => d.status === "active");
}

export function getActiveBills(): RecurringBill[] {
  return data.recurringBills.filter((b) => b.status === "active");
}

export function getBillById(id: string): RecurringBill | undefined {
  return data.recurringBills.find((b) => b.id === id);
}

export function getCategoryById(id: string): Category | undefined {
  return data.categories.find((c) => c.id === id);
}

export function getIncomeSourceById(id: string): IncomeSource | undefined {
  return data.incomeSources.find((s) => s.id === id);
}

/**
 * Finds an active category/source/expense-source by exact name (case-insensitive),
 * or creates a new active one and returns its id. Used for quick-add from the
 * main view entry form. No confirmation prompt, full editing happens later in
 * the Setup modal.
 */
function findOrCreate(
  list: { id: string; name: string; status: Status }[],
  name: string,
): string {
  const trimmed = name.trim();
  const existing = list.find(
    (item) =>
      item.status === "active" &&
      item.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (existing) return existing.id;
  const id = makeId();
  list.push({ id, name: trimmed, status: "active" });
  return id;
}

export function findOrCreateCategory(name: string): string {
  return findOrCreate(data.categories, name);
}

export function findOrCreateIncomeSource(name: string): string {
  return findOrCreate(data.incomeSources, name);
}

export function findOrCreateExpenseSource(name: string): string {
  return findOrCreate(data.expenseSources, name);
}

/* =============================================================================
   RECURRING BILL ROW COMPUTATION
============================================================================= */

export type BillRowKind = "paid" | "pending" | "overdue";

export type BillRow = {
  bill: RecurringBill;
  kind: BillRowKind;
  dueDate: string;
  /** Present only for kind === "paid". */
  instance?: BillInstance;
};

/**
 * Returns the recurring-bill rows to display for the given browsed range.
 *
 * Historical paid instances whose due date falls in [start, end] always show,
 * regardless of which range is being browsed. If today falls within
 * [start, end], each active bill's live `nextDue` additionally shows as
 * "pending" (or "overdue" if nextDue is before today), surfacing bills due
 * soon (this period or next) so they can be paid ahead, and flagging anything
 * that slipped past due. Once paid, it settles into its actual due date's
 * history.
 */
export function getBillRowsForRange(start: string, end: string): BillRow[] {
  const rows: BillRow[] = [];

  for (const inst of data.billInstances) {
    if (inRange(inst.dueDate, start, end)) {
      const bill = getBillById(inst.billId);
      if (bill)
        rows.push({
          bill,
          kind: "paid",
          dueDate: inst.dueDate,
          instance: inst,
        });
    }
  }

  const t = today();
  const todayInThisRange = todayInRange(start, end);
  for (const bill of getActiveBills()) {
    const overdue = bill.nextDue < t;
    const dueInRange = inRange(bill.nextDue, start, end);
    // Pending bills show only in the month they're actually due. Overdue
    // bills also surface in the current month (in addition to their original
    // due month) so they stay visible/actionable until paid.
    if (dueInRange || (overdue && todayInThisRange)) {
      rows.push({
        bill,
        kind: overdue ? "overdue" : "pending",
        dueDate: bill.nextDue,
      });
    }
  }

  rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return rows;
}

/**
 * Active bills that are overdue right now (unpaid, nextDue before today).
 * Independent of the browsed range, used to drive a persistent "Overdue"
 * indicator regardless of navigation.
 */
export function getOverdueBills(): RecurringBill[] {
  const t = today();
  return getActiveBills().filter((b) => b.nextDue < t);
}

/* =============================================================================
   TOTALS
============================================================================= */

export type RangeTotals = {
  income: number;
  fixedRecurring: number;
  variableRecurring: number;
  totalRecurring: number;
  fluctuating: number;
  net: number;
};

/**
 * Live totals for a given browsed range. Recurring totals only count bills
 * that have actually been paid (kind === "paid", using actualAmount),
 * pending/overdue bills still show in the bills panel so you know what's
 * coming, but don't affect Net until they're settled.
 */
export function computeTotals(start: string, end: string): RangeTotals {
  const income = data.incomeEntries
    .filter((e) => inRange(e.date, start, end))
    .reduce((sum, e) => sum + e.actual, 0);

  const fluctuating = data.fluctuatingExpenses
    .filter((e) => inRange(e.date, start, end))
    .reduce((sum, e) => sum + e.amount, 0);

  let fixedRecurring = 0;
  let variableRecurring = 0;
  for (const row of getBillRowsForRange(start, end)) {
    if (row.kind !== "paid") continue;
    const amount = row.instance!.actualAmount;
    if (row.bill.billType === "fixed") fixedRecurring += amount;
    else variableRecurring += amount;
  }

  const totalRecurring = fixedRecurring + variableRecurring;
  const net = income - totalRecurring - fluctuating;

  return {
    income,
    fixedRecurring,
    variableRecurring,
    totalRecurring,
    fluctuating,
    net,
  };
}

/* =============================================================================
   VIEW RANGE: Day / Week / Month / Year navigation
============================================================================= */

function computeMonthRange(
  year: number,
  month: number,
): { start: string; end: string } {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  return { start: localDateString(first), end: localDateString(last) };
}

/** Computes [start, end] for whatever the current viewMode is. */
function computeViewRange(): { start: string; end: string; label: string } {
  switch (viewMode) {
    case "day": {
      const d = localDateString(new Date(viewYear, viewMonth, viewDay));
      return { start: d, end: d, label: formatDate(d) };
    }
    case "week": {
      // viewWeekStart is always Monday
      const start = viewWeekStart;
      const endD = parseDate(start);
      endD.setDate(endD.getDate() + 6);
      const end = localDateString(endD);
      // Week label: "Jun 16 – Jun 22, 2026"
      const s = parseDate(start);
      const e = parseDate(end);
      const sm = MONTH_NAMES[s.getMonth()].slice(0, 3);
      const em = MONTH_NAMES[e.getMonth()].slice(0, 3);
      const label =
        s.getMonth() === e.getMonth()
          ? `${sm} ${s.getDate()} – ${e.getDate()}, ${s.getFullYear()}`
          : `${sm} ${s.getDate()} – ${em} ${e.getDate()}, ${e.getFullYear()}`;
      return { start, end, label };
    }
    case "month": {
      const r = computeMonthRange(viewYear, viewMonth);
      return { ...r, label: `${MONTH_NAMES[viewMonth]} ${viewYear}` };
    }
    case "year": {
      const start = `${viewYear}-01-01`;
      const end = `${viewYear}-12-31`;
      return { start, end, label: String(viewYear) };
    }
  }
}

/** Returns the Monday of the week that contains the given date. */
function mondayOf(d: Date): Date {
  const result = new Date(d);
  const dow = result.getDay(); // 0=Sun
  const diff = dow === 0 ? -6 : 1 - dow;
  result.setDate(result.getDate() + diff);
  return result;
}

/** Snap button label per mode */
const SNAP_LABELS: Record<ViewMode, string> = {
  day: "Today",
  week: "This Week",
  month: "This Month",
  year: "This Year",
};

/** Render the nav label and update viewStart/viewEnd from current view state. */
function renderRangeNav(): void {
  const { start, end, label } = computeViewRange();
  viewStart = start;
  viewEnd = end;
  monthLabelEl.textContent = label;
}

/** Sets the view to the current period (Today / This Week / This Month / This Year). */
function snapToCurrent(): void {
  const now = new Date();
  viewYear = now.getFullYear();
  viewMonth = now.getMonth();
  viewDay = now.getDate();
  viewWeekStart = localDateString(mondayOf(now));
  renderRangeNav();
  renderAll();
}

/** Shift the viewed period by delta (±1) in the current mode. */
function shiftRange(delta: number): void {
  switch (viewMode) {
    case "day": {
      const d = new Date(viewYear, viewMonth, viewDay + delta);
      viewYear = d.getFullYear();
      viewMonth = d.getMonth();
      viewDay = d.getDate();
      break;
    }
    case "week": {
      const d = parseDate(viewWeekStart);
      d.setDate(d.getDate() + delta * 7);
      viewWeekStart = localDateString(d);
      break;
    }
    case "month": {
      viewMonth += delta;
      if (viewMonth < 0) {
        viewMonth = 11;
        viewYear -= 1;
      } else if (viewMonth > 11) {
        viewMonth = 0;
        viewYear += 1;
      }
      break;
    }
    case "year":
      viewYear += delta;
      break;
  }
  renderRangeNav();
  if (appSettings.startupMode === "last-view") saveLastView();
  renderAll();
}

/** Switch to a new view mode and re-render everything. */
function setViewMode(mode: ViewMode): void {
  viewMode = mode;
  // Sync the point-in-time across modes using the current viewYear/viewMonth
  const now = new Date();
  if (mode === "day") {
    viewDay = viewDay || now.getDate();
  } else if (mode === "week") {
    viewWeekStart = localDateString(
      mondayOf(new Date(viewYear, viewMonth, viewDay || 1)),
    );
  }
  // Update snap button label
  snapBtnEl.textContent = SNAP_LABELS[mode];
  // Update inline edit placeholder
  const placeholders: Record<ViewMode, string> = {
    day: "YYYY-MM-DD",
    week: "Mon YYYY (week)",
    month: "Mon YYYY",
    year: "YYYY",
  };
  monthInputEl.placeholder = placeholders[mode];
  // Activate the right view mode button
  viewModeBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === mode);
  });
  // Save mode to settings if "last view" startup mode is active
  if (appSettings.startupMode === "last-view") saveLastView();
  renderRangeNav();
  renderAll();
}

/** Saves the current view state so "Show Last View" can restore it. */
function saveLastView(): void {
  try {
    const state = {
      mode: viewMode,
      year: viewYear,
      month: viewMonth,
      day: viewDay,
      weekStart: viewWeekStart,
    };
    localStorage.setItem("budgetLastView", JSON.stringify(state));
  } catch {
    /* non-critical */
  }
}

/** Restores the last view if the startup setting calls for it. */
function restoreLastView(): void {
  try {
    const raw = localStorage.getItem("budgetLastView");
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.mode) viewMode = s.mode as ViewMode;
    if (typeof s.year === "number") viewYear = s.year;
    if (typeof s.month === "number") viewMonth = s.month;
    if (typeof s.day === "number") viewDay = s.day;
    if (typeof s.weekStart === "string") viewWeekStart = s.weekStart;
  } catch {
    /* ignore */
  }
}

/** Inline-edit commit, parses the text input and jumps to that period. */
function commitRangeInput(): void {
  const raw = monthInputEl.value.trim();
  let jumped = false;
  if (viewMode === "day") {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      viewYear = d.getFullYear();
      viewMonth = d.getMonth();
      viewDay = d.getDate();
      jumped = true;
    }
  } else if (viewMode === "week") {
    // Accept "Mon YYYY" to jump to that month's first week
    const parts = raw.split(/\s+/);
    if (parts.length >= 2) {
      const mi = MONTH_NAMES.findIndex((m) =>
        m.toLowerCase().startsWith(parts[0].toLowerCase()),
      );
      const y = parseInt(parts[1], 10);
      if (mi >= 0 && !isNaN(y)) {
        viewWeekStart = localDateString(mondayOf(new Date(y, mi, 1)));
        viewYear = y;
        viewMonth = mi;
        jumped = true;
      }
    }
  } else if (viewMode === "month") {
    const parts = raw.split(/\s+/);
    if (parts.length === 2) {
      const mi = MONTH_NAMES.findIndex((m) =>
        m.toLowerCase().startsWith(parts[0].toLowerCase()),
      );
      const y = parseInt(parts[1], 10);
      if (mi >= 0 && !isNaN(y) && y > 1900 && y < 2200) {
        viewYear = y;
        viewMonth = mi;
        jumped = true;
      }
    }
  } else if (viewMode === "year") {
    const y = parseInt(raw, 10);
    if (!isNaN(y) && y > 1900 && y < 2200) {
      viewYear = y;
      jumped = true;
    }
  }
  monthInputEl.style.display = "none";
  monthLabelEl.style.display = "";
  if (jumped) {
    renderRangeNav();
    renderAll();
  }
}

// Keep the old name for the single caller that used it, now an alias
function renderMonthNav(): void {
  renderRangeNav();
}
function shiftMonth(delta: number): void {
  shiftRange(delta);
}

/* =============================================================================
   APP SETTINGS  (read-only here, shell.ts owns writing settings.json)
============================================================================= */

type BudgetAppSettings = {
  americanDates: boolean;
  quickDelete: boolean;
  showCleared: boolean;
  startupMode: "current-month" | "last-view";
  /* ── Budget reminders (see the BUDGET REMINDERS section) ───────────────── */
  reminderEnabled: boolean;
  /** "interval" counts days since the last change; "monthly" fires on fixed
   *  days of the month (payday, the 1st, whenever the bills land). */
  reminderMode: BudgetReminderMode;
  /** Days between nudges in interval mode. Integer, 1–366. */
  reminderDays: number;
  /** Days of the month that trigger a nudge in monthly mode. Integers 1–31,
   *  sorted and de-duplicated; a day past the end of a short month folds to
   *  that month's last day. */
  reminderMonthDays: number[];
  /** false = Gentle (toast), true = Aggressive (startup modal). */
  reminderAggressive: boolean;
  /** Epoch ms of the last change to any budget data. 0 = never recorded. */
  lastUpdatedAt: number;
  /** Cached newestBudgetDataAt() from the last time the data was readable.
   *  Denormalized on purpose: on an encrypted budget the data can't be read at
   *  startup, which is exactly when the reminder needs to know how current it
   *  is. Refreshed whenever the data IS readable. 0 = never computed. */
  dataNewestAt: number;
};

type BudgetReminderMode = "interval" | "monthly";

let appSettings: BudgetAppSettings = {
  americanDates: false,
  quickDelete: false,
  showCleared: true,
  startupMode: "current-month",
  reminderEnabled: false,
  reminderMode: "interval",
  reminderDays: 7,
  reminderMonthDays: [1],
  reminderAggressive: false, // Gentle by default
  lastUpdatedAt: 0,
  dataNewestAt: 0,
};

async function loadAppSettings(): Promise<void> {
  try {
    // americanDates is SHELL-owned (General Settings' Date Format), read it
    // from the shared settings.json; everything else Budget owns lives in
    // Budget's own settings file.
    const sharedRaw = await invoke<string>("load_settings");
    const shared = JSON.parse(sharedRaw || "{}");
    appSettings.americanDates = !!shared.americanDates;

    const ownRaw = await invoke<string>("load_tool_settings", { toolId: "budget" });
    const own = JSON.parse(ownRaw || "{}");
    const hasOwnFile =
      own && typeof own === "object" &&
      ("quickDelete" in own || "showCleared" in own || "startupMode" in own);

    if (hasOwnFile) {
      appSettings.quickDelete = !!own.quickDelete;
      appSettings.showCleared = own.showCleared !== false; // default on
      appSettings.startupMode =
        own.startupMode === "last-view" ? "last-view" : "current-month";
      readReminderSettings(own);
    } else {
      // First run after the settings split: adopt any legacy budget* keys
      // still in settings.json, then persist them to the new home so the
      // migration happens exactly once.
      const hadLegacy =
        "budgetQuickDelete" in shared ||
        "budgetShowCleared" in shared ||
        "budgetStartupMode" in shared;
      appSettings.quickDelete = !!shared.budgetQuickDelete;
      appSettings.showCleared = shared.budgetShowCleared !== false; // default on
      appSettings.startupMode =
        shared.budgetStartupMode === "last-view" ? "last-view" : "current-month";
      if (hadLegacy) void saveAppSettings();
    }
  } catch {
    // keep defaults
  }
}

/** Pulls the reminder keys out of Budget's own settings file, clamping every
 *  one. This file is user-editable and a bad value here would otherwise reach
 *  the due-date arithmetic. Missing keys fall back to the defaults already on
 *  appSettings, so a settings file written before reminders existed loads with
 *  reminders simply off. */
function readReminderSettings(own: Record<string, unknown>): void {
  appSettings.reminderEnabled = own.reminderEnabled === true;
  appSettings.reminderMode =
    own.reminderMode === "monthly" ? "monthly" : "interval";
  appSettings.reminderDays =
    typeof own.reminderDays === "number" &&
    Number.isInteger(own.reminderDays) &&
    own.reminderDays >= 1 &&
    own.reminderDays <= 366
      ? own.reminderDays
      : 7;
  appSettings.reminderMonthDays = Array.isArray(own.reminderMonthDays)
    ? normalizeMonthDays(own.reminderMonthDays)
    : [1];
  // An empty list would mean "monthly mode that can never fire", a setting
  // with no way to reach it from the UI, so treat it as unset.
  if (appSettings.reminderMonthDays.length === 0) appSettings.reminderMonthDays = [1];
  appSettings.reminderAggressive = own.reminderAggressive === true;
  appSettings.lastUpdatedAt =
    typeof own.lastUpdatedAt === "number" && own.lastUpdatedAt > 0
      ? own.lastUpdatedAt
      : 0;
  appSettings.dataNewestAt =
    typeof own.dataNewestAt === "number" && own.dataNewestAt > 0
      ? own.dataNewestAt
      : 0;
}

async function saveAppSettings(): Promise<void> {
  try {
    // Budget's own file, Budget's own keys. No shared-file merge dance, no
    // possibility of another writer's save erasing these (or vice versa).
    const own = {
      quickDelete: appSettings.quickDelete,
      showCleared: appSettings.showCleared,
      startupMode: appSettings.startupMode,
      reminderEnabled: appSettings.reminderEnabled,
      reminderMode: appSettings.reminderMode,
      reminderDays: appSettings.reminderDays,
      reminderMonthDays: appSettings.reminderMonthDays,
      reminderAggressive: appSettings.reminderAggressive,
      lastUpdatedAt: appSettings.lastUpdatedAt,
      dataNewestAt: appSettings.dataNewestAt,
    };
    await invoke("save_tool_settings", { toolId: "budget", data: JSON.stringify(own) });
  } catch {
    /* non-critical */
  }
}

/* =============================================================================
   BUDGET REMINDERS
   -----------------------------------------------------------------------------
   A nudge to go put your actual numbers in, modelled on Auto-Backup's reminder
   and the new-version notifier. Same three parts, so all three behave alike:

     • a persistent signal while something is owed (sidebar row pulse + a line
       in the tool header), which stays up until it's dealt with;
     • a one-shot startup nudge, Gentle (toast) or Aggressive (modal);
     • an enable toggle with its own schedule settings, in this tool's Setup.

   Everything measures from ONE number, budgetBaselineAt():

       max(lastUpdatedAt, cached data date, newest non-future date in the data)

   Two real sources (the third is just a cache of the second) because neither
   alone is right:

     • lastUpdatedAt (a stamp written on every save) knows when you last
       touched the tool, but it starts at zero, so a budget that's been
       sitting untouched for a month has no stamp at all, and measuring from
       "whenever the stamp got created" would tell a brand-new reminder that
       everything is perfectly up to date. That was the original bug here.
     • The data's own newest date knows how current your numbers actually are,
       which is the thing being asked about, but it can't see a review that
       added nothing (Mark Reviewed) or an edit to an existing entry.

   Taking the later of the two means both answers count, and whichever is more
   recent wins. Future-dated records are ignored, entering next month's rent
   today shouldn't buy you a month of silence.

   Two schedules read the baseline:

     interval  every N days since it.
     monthly   on given days of the month (payday, the 1st, whenever bills
               land), due if the baseline predates the most recent one.

   Both live in Budget's own (unencrypted) settings file rather than in the
   budget data, which is what makes this work when encryption is on: the data
   itself can't be read at startup, which is precisely when the reminder needs
   to know how current it is. The cached data date is refreshed at every point
   where the data IS readable (after load, and after any mutation) so an
   encrypted budget is measured correctly from the launch after its first
   unlock.

   There's deliberately no "dismissed" state. Like Auto-Backup's, the reminder
   is owed until the thing it's asking for actually happens, dismissing the
   modal quiets this run, not the next one. Mark Reviewed is the way to say
   "I looked, there was nothing to add"; see markBudgetReviewed().
============================================================================= */

/** Reminder status when a nudge is owed, null otherwise (reminders off, no
 *  baseline recorded yet, or simply not time). Read by shell.ts's startup
 *  sequence and by refreshBudgetDueUI(). */
export interface BudgetReminderStatus {
  aggressive: boolean;
  /** Whole days since the budget was last changed. */
  elapsedDays: number;
}

/** Local-midnight epoch ms for a YYYY-MM-DD string, or 0 if it isn't one.
 *  Parsed by hand rather than through `new Date(str)`, which reads a bare
 *  YYYY-MM-DD as UTC midnight and lands on the previous day west of Greenwich. */
function dateStrToLocalMs(dateStr: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** Newest date in the budget that isn't in the future, as local-midnight epoch
 *  ms, 0 when there's nothing to measure (no data, or none of it loaded).
 *
 *  Reads the three record types that represent the user actually putting
 *  numbers in: logged income, logged expenses, and paid bills. Recurring bill
 *  DEFINITIONS are deliberately excluded, a bill's nextDue is a schedule the
 *  app maintains on its own, so counting it would let a budget with one
 *  recurring bill in it look permanently up to date. */
function newestBudgetDataAt(): number {
  let newest = 0;
  const consider = (dateStr: string): void => {
    const ms = dateStrToLocalMs(dateStr);
    if (ms > newest) newest = ms;
  };

  for (const e of data.incomeEntries) consider(e.date);
  for (const e of data.fluctuatingExpenses) consider(e.date);
  for (const b of data.billInstances) consider(b.paidDate);

  // Entering next month's rent today shouldn't buy a month of silence, so a
  // future-dated record doesn't count as "up to date as of then".
  return newest > Date.now() ? 0 : newest;
}

/** Refreshes the cached data date. Only ever called from points where `data`
 *  is known to hold the real thing, an encrypted budget looks empty until it's
 *  unlocked, and caching a 0 from that state would erase what the reminder
 *  knows about it. */
function syncDataNewestAt(): void {
  const newest = newestBudgetDataAt();
  if (newest === appSettings.dataNewestAt) return;
  appSettings.dataNewestAt = newest;
  void saveAppSettings();
}

/** The single point every schedule measures from, see the section header for
 *  why it's the later of these rather than any one alone. The cache and the
 *  live read are both here so it's correct before the data is readable (cache)
 *  and immediately after it changes (live), without waiting for a save. */
function budgetBaselineAt(): number {
  return Math.max(
    appSettings.lastUpdatedAt,
    appSettings.dataNewestAt,
    newestBudgetDataAt(),
  );
}

export function getDueBudgetReminder(): BudgetReminderStatus | null {
  if (!appSettings.reminderEnabled) return null;

  const baseline = budgetBaselineAt();
  // Nothing to measure from: an empty budget that has never been saved. There's
  // no "you're behind" to report when there's no history at all.
  if (!baseline) return null;

  const now = Date.now();
  const due = isReminderDue(
    baseline,
    appSettings.reminderMode,
    appSettings.reminderDays,
    appSettings.reminderMonthDays,
    now,
  );
  if (!due) return null;

  return {
    aggressive: appSettings.reminderAggressive,
    elapsedDays: Math.floor((now - baseline) / DAY_MS),
  };
}

/** How stale the persisted stamp is allowed to get. Everything reading it works
 *  in whole days, so writing the settings file on every single mutation would
 *  be a lot of disk churn to record a difference nothing can observe. */
const STAMP_PERSIST_INTERVAL_MS = 60_000;

/** Stamps "the budget just changed" and clears any owed reminder with it.
 *  Called from queueSave(), so it covers every mutation path without each one
 *  having to remember. */
function markBudgetUpdated(): void {
  const now = Date.now();
  const shouldPersist = now - appSettings.lastUpdatedAt >= STAMP_PERSIST_INTERVAL_MS;
  appSettings.lastUpdatedAt = now;
  if (shouldPersist) void saveAppSettings();
  // A mutation means the data is loaded, so this is a safe point to re-cache.
  syncDataNewestAt();
  refreshBudgetDueUI();
}

/* Confirmation for the header's Mark Reviewed button. Lazily constructed on
   first use, matching how the other Budget modals are built. The tool's DOM
   exists from the start, but there's no reason to instantiate a Modal nobody
   has asked for yet.

   Only the header button is guarded. The Aggressive reminder modal's "Nothing
   to add, mark it reviewed" is already a deliberate pick from three labelled
   options, and stacking a second modal on top of a choice the user just read
   and made would be noise, not safety. The header button is a single click
   with no surrounding context, which is the case worth catching. */
let reviewConfirmModal: Modal | null = null;

function getReviewConfirmModal(): Modal {
  if (!reviewConfirmModal) {
    reviewConfirmModal = new Modal(
      document.getElementById("budgetReviewConfirmBackdrop")!,
      { closeOnEsc: true },
    );
  }
  return reviewConfirmModal;
}

/** Clears an owed reminder without touching any budget data.
 *
 *  Budget is the one of the three reminders with no natural clearing event.
 *  A backup reminder clears when a backup runs and a version notice clears
 *  when you're on the latest release, but "go update your budget" can be
 *  correctly answered with "I looked, there was nothing to add", and there'd
 *  otherwise be no way to say so short of inventing an entry.
 *
 *  Restarts the same clock a real edit would, so the next nudge lands a full
 *  interval from now rather than immediately. Persists unconditionally (unlike
 *  markBudgetUpdated's throttle): this is a deliberate one-shot action, and it
 *  has to survive a close right after it. */
export function markBudgetReviewed(): void {
  appSettings.lastUpdatedAt = Date.now();
  void saveAppSettings();
  refreshBudgetDueUI();
}

/** Lights or clears the persistent signals: the sidebar row pulse, the line in
 *  the tool header, and the Mark Reviewed button beside it. Safe to call
 *  anytime and from anywhere. Every element is looked up per call, since this
 *  runs from paths that can precede the init that would have cached them. */
function refreshBudgetDueUI(): void {
  const status = getDueBudgetReminder();
  const due = status !== null;

  setToolAttention("finance", "budget", due);

  // The Mark Reviewed button lives inside this wrapper, so it appears and
  // disappears with the notice without needing its own toggle.
  const notice = document.getElementById("budgetDueNotice");
  const daysEl = document.getElementById("budgetDueDays");
  if (notice && daysEl) {
    if (due) daysEl.textContent = String(status.elapsedDays);
    notice.style.display = due ? "" : "none";
  }
}

/** Called by shell.ts when the user toggles Date Format in Settings. */
export function setBudgetAmericanDates(value: boolean): void {
  if (appSettings.americanDates === value) return;
  appSettings.americanDates = value;
  renderAll(); // re-render everything so all displayed dates update immediately
}

/** Formats a YYYY-MM-DD date string per the shared date format setting. */
function formatDate(dateStr: string): string {
  if (!appSettings.americanDates) return dateStr;
  const [y, m, d] = dateStr.split("-");
  return `${m}-${d}-${y}`;
}

/* =============================================================================
   FORMATTING
============================================================================= */

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function formatCurrency(n: number): string {
  const s = currencyFormatter.format(n);
  // Insert a space between the minus sign and the dollar sign for readability:
  // "-$1,234.56" → "- $1,234.56"
  return n < 0 ? s.replace("-$", "- $") : s;
}

/* =============================================================================
   LEDGER  (income entries + fluctuating expenses, combined for display)
============================================================================= */

type LedgerItem =
  | { kind: "income"; entry: IncomeEntry }
  | { kind: "expense"; entry: FluctuatingExpense }
  | { kind: "bill"; bill: RecurringBill; instance: BillInstance };

function getLedgerForRange(start: string, end: string): LedgerItem[] {
  const items: LedgerItem[] = [];
  for (const e of data.incomeEntries) {
    if (inRange(e.date, start, end)) items.push({ kind: "income", entry: e });
  }
  for (const e of data.fluctuatingExpenses) {
    if (inRange(e.date, start, end)) items.push({ kind: "expense", entry: e });
  }
  // Item 9: paid recurring bills appear in the ledger on their paidDate
  for (const inst of data.billInstances) {
    if (inRange(inst.paidDate, start, end)) {
      const bill = getBillById(inst.billId);
      if (bill) items.push({ kind: "bill", bill, instance: inst });
    }
  }
  // Sort by the relevant date for each item type
  items.sort((a, b) => {
    const dateA = a.kind === "bill" ? a.instance.paidDate : a.entry.date;
    const dateB = b.kind === "bill" ? b.instance.paidDate : b.entry.date;
    return dateA.localeCompare(dateB);
  });
  return items;
}

/** Signed contribution of a single ledger item to a "net" subtotal, income
 *  adds (money in), expenses and bill payments subtract (money out). Mirrors
 *  the sign convention already used for ledger row coloring above. */
function itemNetAmount(item: LedgerItem): number {
  if (item.kind === "income") return item.entry.actual;
  if (item.kind === "expense") return -item.entry.amount;
  return -item.instance.actualAmount;
}

/** Net total across a list of ledger items, used for the totals shown next
 *  to date/type/source subheadings in the ledger. */
function sumNetAmount(items: LedgerItem[]): number {
  return items.reduce((sum, item) => sum + itemNetAmount(item), 0);
}

/* =============================================================================
   DOM REFS & UI STATE  (resolved in initBudget)
============================================================================= */

let monthLabelEl: HTMLElement;
let monthInputEl: HTMLInputElement;
let monthPrevBtn: HTMLButtonElement;
let monthNextBtn: HTMLButtonElement;
let snapBtnEl: HTMLButtonElement;
let viewModeBtns: HTMLButtonElement[];

// Budget Settings tab, startup mode select (item 4)
let budgetStartupModeSelect: HTMLSelectElement;

// Bill Editor modal, autopay toggle label (item 7)
let billAutopayLabelEl: HTMLElement;

// Bill Pay modal, cleared toggle label (item 7)
let billActionClearedLabelEl: HTMLElement;

// Delete entry confirm modal, specific message (item 8)
let deleteMessageEl: HTMLElement;

// Budget Settings tab (item 10)
let budgetQuickDeleteToggle: HTMLInputElement;
let budgetQuickDeleteLabel: HTMLElement;
let budgetShowClearedToggle: HTMLInputElement;
let budgetShowClearedLabel: HTMLElement;

// Budget Settings tab, reminders
let budgetReminderToggle: HTMLInputElement;
let budgetReminderLabel: HTMLElement;
let budgetReminderSubsettings: HTMLElement;
let budgetReminderModeSelect: HTMLSelectElement;
let budgetReminderDaysRow: HTMLElement;
let budgetReminderDaysInput: HTMLInputElement;
let budgetReminderMonthDaysRow: HTMLElement;
let budgetReminderMonthDaysInput: HTMLInputElement;
let budgetReminderAggressiveToggle: HTMLInputElement;
let budgetReminderModeLabel: HTMLElement;

let typeIncomeBtn: HTMLButtonElement;
let typeExpenseBtn: HTMLButtonElement;
let incomeFieldsEl: HTMLElement;
let expenseFieldsEl: HTMLElement;

let incomeDateInput: HTMLInputElement;
let incomeSourceInput: HTMLInputElement;
let incomeExpectedInput: HTMLInputElement;
let incomeActualInput: HTMLInputElement;
let incomeNotesInput: HTMLInputElement;
let addIncomeBtn: HTMLButtonElement;

let expenseDateInput: HTMLInputElement;
let expenseCategoryInput: HTMLInputElement;
let expenseSourceInput: HTMLInputElement;
let expenseAmountInput: HTMLInputElement;
let expenseNotesInput: HTMLInputElement;
let addExpenseBtn: HTMLButtonElement;

let sourceDatalist: HTMLDataListElement;
let categoryDatalist: HTMLDataListElement;
let expenseSourceDatalist: HTMLDataListElement;

let totalsEl: HTMLElement;
let categorySummaryEl: HTMLElement;
let sourceSummaryEl: HTMLElement;
let billsEl: HTMLElement;
let overdueBadgeEl: HTMLElement;
let entriesEl: HTMLElement;
let ledgerSortSelect: HTMLSelectElement;

// Summary panel tab state
type SummaryTab = "overview" | "category" | "source" | "expect";
let activeSummaryTab: SummaryTab = "overview";

// Ledger sort/grouping mode
type LedgerSortMode = "chrono" | "grouped" | "alpha-source";
let ledgerSortMode: LedgerSortMode = "chrono";

// Annual stats flip state
let annualStatsVisible = false;

// Chart type for category/source summary panes
type ChartType = "bar" | "pie";
let categoryChartType: ChartType = "bar";
let sourceChartType: ChartType = "bar";

let actualTouched = false;

let pendingDelete: { kind: "income" | "expense"; id: string } | null = null;
let deleteModal: Modal | null = null;

// Mark Paid / Edit Payment modal
let billActionTitleEl: HTMLElement;
let billActionSubtitleEl: HTMLElement;
let billActionDetailsEl: HTMLElement;
let billActionAmountInput: HTMLInputElement;
let billActionDateInput: HTMLInputElement;
let billActionClearedCheckbox: HTMLInputElement;
let billActionClearedDateField: HTMLElement;
let billActionClearedRowEl: HTMLElement;
let billActionClearedDateInput: HTMLInputElement;
let billActionNotesInput: HTMLInputElement;
let billActionNextDueField: HTMLElement;
let billActionNextDueInput: HTMLInputElement;
let billActionSaveBtn: HTMLButtonElement;
let billActionUndoBtn: HTMLButtonElement;
let billActionCancelBtn: HTMLButtonElement;
let billActionCloseBtn: HTMLButtonElement;

// Setup modal. Categories / Income Sources / Expense Sources (simple lists)
let categoriesListEl: HTMLElement;
let sourcesListEl: HTMLElement;
let expenseSourcesListEl: HTMLElement;
let categoryNewBtn: HTMLButtonElement;
let sourceNewBtn: HTMLButtonElement;
let expenseSourceNewBtn: HTMLButtonElement;

// Setup modal. Recurring Bills list
let billsListEl: HTMLElement;
let billNewBtn: HTMLButtonElement;

// Bill Editor modal (Add/Edit Recurring Bill)
let billEditTitleEl: HTMLElement;
let billNameInput: HTMLInputElement;
let billTypeSelect: HTMLSelectElement;
let billAmountInput: HTMLInputElement;
let billIntervalInput: HTMLInputElement;
let billUnitSelect: HTMLSelectElement;
let billNextDueInput: HTMLInputElement;
let billPayMethodInput: HTMLInputElement;
let billAutopayCheckbox: HTMLInputElement;
let billNotesInput: HTMLInputElement;
let billSaveBtn: HTMLButtonElement;
let billRetireBtn: HTMLButtonElement;
let billDeleteBtn: HTMLButtonElement;
let billCancelBtn: HTMLButtonElement;
let billBackBtn: HTMLButtonElement;
let billCloseBtn: HTMLButtonElement;

/* =============================================================================
   RENDERING
============================================================================= */

function buildTotalRow(label: string, value: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "budget-total-row";

  const labelSpan = document.createElement("span");
  labelSpan.className = "budget-total-label";
  labelSpan.textContent = label;
  row.appendChild(labelSpan);

  const valueSpan = document.createElement("span");
  valueSpan.className = "budget-total-value";
  valueSpan.textContent = formatCurrency(value);
  row.appendChild(valueSpan);

  return row;
}

/* Switches the visible summary pane and re-renders its content.
   Scoped to .budget-summary-tabs rather than querying the bare class. That
   class used to be borrowed by the Licensing modal for its theme styling,
   and this query reached across and marked those tabs active too (while
   blanking every pane here, since they carry no data-summary-tab). The
   Licensing modal now uses modal.css's .modal-tab like every other modal, so
   nothing shares this class today; the scope stays because a presentational
   class is never a safe thing to query globally. */
function activateSummaryTab(tab: SummaryTab): void {
  activeSummaryTab = tab;
  document
    .querySelectorAll<HTMLButtonElement>(".budget-summary-tabs .budget-summary-tab")
    .forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.summaryTab === tab);
    });
  (
    document.getElementById("budgetSummaryOverview") as HTMLElement
  ).style.display = tab === "overview" ? "" : "none";
  (
    document.getElementById("budgetSummaryCategory") as HTMLElement
  ).style.display = tab === "category" ? "" : "none";
  (
    document.getElementById("budgetSummarySource") as HTMLElement
  ).style.display = tab === "source" ? "" : "none";
  (
    document.getElementById("budgetSummaryExpect") as HTMLElement
  ).style.display = tab === "expect" ? "" : "none";
  if (tab === "category") renderCategorySummary();
  if (tab === "source") renderSourceSummary();
  if (tab === "expect") renderExpectSummary();
}

function buildSummaryRow(
  label: string,
  charges: number,
  avg: number,
  total: number,
  isTotal = false,
  excluded = false,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "budget-summary-row" + (isTotal ? " budget-summary-row-total" : "");

  const labelSpan = document.createElement("span");
  labelSpan.className = "budget-summary-col-label";

  if (excluded && !isTotal) {
    // Wrap text + icon in an inline-flex container so ellipsis still works
    labelSpan.style.cssText = "display:flex;align-items:center;gap:5px;min-width:0;";
    const text = document.createElement("span");
    text.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;";
    text.textContent = label;
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.classList.add("budget-summary-excluded-icon");
    // Proper SVG tooltip via <title> child, plus HTML title attribute for fallback
    const svgTitle = document.createElementNS("http://www.w3.org/2000/svg", "title");
    svgTitle.textContent = "Excluded from Charts";
    // Eye with diagonal slash through it (eye-off)
    icon.innerHTML =
      '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>' +
      '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>' +
      '<line x1="1" y1="1" x2="23" y2="23"/>';
    icon.insertBefore(svgTitle, icon.firstChild);
    labelSpan.append(text, icon);
  } else {
    labelSpan.textContent = label;
  }

  const chargesSpan = document.createElement("span");
  chargesSpan.className = "budget-summary-col-num";
  chargesSpan.textContent = isTotal ? "" : String(charges);

  const avgSpan = document.createElement("span");
  avgSpan.className = "budget-summary-col-num";
  avgSpan.textContent = isTotal ? "" : formatCurrency(avg);

  const totalSpan = document.createElement("span");
  totalSpan.className = "budget-summary-col-num budget-summary-col-total";
  totalSpan.textContent = formatCurrency(total);

  row.append(labelSpan, chargesSpan, avgSpan, totalSpan);
  return row;
}

function buildSummaryHeader(firstColLabel: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "budget-summary-row budget-summary-row-header";

  const cols = [firstColLabel, "Charges", "Avg", "Total"];
  for (const col of cols) {
    const span = document.createElement("span");
    span.className = col === firstColLabel ? "budget-summary-col-label" : "budget-summary-col-num";
    span.textContent = col;
    row.appendChild(span);
  }
  return row;
}

/* =============================================================================
   SUMMARY CHART
   Draws a bar or pie chart onto the given canvas from name/value pairs.
   Colors come from the active theme's CSS custom properties.

   Bar chart: positive values up, negative values below baseline (dimmed, no %).
   Pie chart: positive values only.
   Hover tooltip (2s delay): name + % for pos; name-only for neg bars.
   Expanded modal version: adds axis lines and value ticks.
============================================================================= */

/** Read a CSS custom property from the root element at draw time. */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Converts a CSS color value to a valid hex/rgb string, or returns fallback. */
function safeColor(raw: string, fallback: string): string {
  const s = raw.trim();
  if (!s) return fallback;
  // Test by assigning to a temporary canvas context
  const tmp = document.createElement("canvas").getContext("2d")!;
  tmp.fillStyle = "#000"; // known baseline
  tmp.fillStyle = s;
  // If the assignment was accepted, fillStyle changes from baseline
  return tmp.fillStyle !== "#000000" ? s : fallback;
}

/**
 * Computes relative luminance of a hex color and returns a contrasting
 * text color, dark (#1a1a1a) for light backgrounds, light (#f0f0f0) for dark.
 * Used for pie slice percentage labels so text is always readable.
 */
function contrastTextColor(hex: string): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return "#f0f0f0";
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  // sRGB luminance
  const toLinear = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return L > 0.35 ? "#1a1a1a" : "#f0f0f0";
}

function getChartPalette(): string[] {
  // Dedicated chart color vars, themes define these for curated chart palettes.
  // If a theme doesn't define them (or they're invalid), fall back to the
  // hardcoded set below which ensures good contrast and visual variety.
  const chartVars = [
    "--color-chart-1", "--color-chart-2", "--color-chart-3", "--color-chart-4",
    "--color-chart-5", "--color-chart-6", "--color-chart-7", "--color-chart-8",
  ];
  // Fallback: 8 perceptually-distinct hues spread 45° apart, medium saturation,
  // readable on both dark and light panel backgrounds.
  const fallbacks = [
    "#4fc3f7", // sky blue
    "#81c784", // sage green
    "#ffb74d", // amber
    "#e57373", // rose
    "#ce93d8", // lavender
    "#4db6ac", // teal
    "#f06292", // pink
    "#fff176", // pale yellow
  ];
  const palette = chartVars.map((v, i) => safeColor(cssVar(v), fallbacks[i]));
  // Ensure no two adjacent colors are too similar (perceptual hue shift check).
  // If adjacent colors parse as very close hex values, shift the second's lightness.
  return palette;
}

interface ChartEntry { name: string; value: number; }
interface PieSegment { name: string; value: number; pct: number; startAngle: number; endAngle: number; color: string; cx: number; cy: number; r: number; }
interface BarSegment { name: string; value: number; pct: number | null; x: number; y: number; w: number; h: number; color: string; isNeg: boolean; }

function drawSummaryChart(
  canvas: HTMLCanvasElement,
  entries: ChartEntry[],
  type: ChartType,
  expanded = false,
): { pie: PieSegment[]; bar: BarSegment[] } {
  const dpr = window.devicePixelRatio || 1;
  // canvas.clientWidth is 0 when the flex column hasn't been painted yet.
  // Walk up to the parent to get a real pixel width, then derive height from
  // the CSS aspect-ratio (1:1 for inline, or use offsetHeight for the modal).
  let W = canvas.clientWidth || canvas.offsetWidth;
  if (!W) W = (canvas.parentElement?.clientWidth || canvas.parentElement?.offsetWidth || 200);
  let H = canvas.clientHeight || canvas.offsetHeight;
  if (!H) H = expanded ? 420 : W; // inline is square; modal has fixed CSS height
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const palette    = getChartPalette();
  const textColor  = safeColor(cssVar("--color-text-muted"), "#888888");
  const borderColor = safeColor(cssVar("--color-border"), "#444444");
  const posItems   = entries.filter((e) => e.value > 0);
  const negItems   = entries.filter((e) => e.value < 0);
  const posTotal   = posItems.reduce((s, e) => s + e.value, 0);

  if (entries.length === 0) return { pie: [], bar: [] };

  // ── PIE ─────────────────────────────────────────────────────────────────
  if (type === "pie") {
    if (posTotal === 0) return { pie: [], bar: [] };
    const legendRows = expanded ? Math.ceil(posItems.length / 2) : 0;
    const legendH    = legendRows * 14 + (legendRows > 0 ? 8 : 0);
    const cx = W / 2;
    const cy = (H - legendH) / 2;
    const r  = Math.min(cx, cy) - (expanded ? 20 : 6);
    const segments: PieSegment[] = [];
    let angle = -Math.PI / 2;

    posItems.forEach((e, i) => {
      const pct   = e.value / posTotal;
      const slice = pct * Math.PI * 2;
      const color = palette[i % palette.length];
      segments.push({ name: e.name, value: e.value, pct, startAngle: angle, endAngle: angle + slice, color, cx, cy, r });

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angle, angle + slice);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.3)";
      ctx.lineWidth = 1;
      ctx.stroke();

      if (expanded && pct > 0.06) {
        const mid = angle + slice / 2;
        const lx = cx + Math.cos(mid) * r * 0.65;
        const ly = cy + Math.sin(mid) * r * 0.65;
        ctx.fillStyle = contrastTextColor(color);
        ctx.font = `bold ${Math.max(9, Math.floor(r * 0.13))}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(Math.round(pct * 100) + "%", lx, ly);
      }
      angle += slice;
    });

    if (expanded && legendRows > 0) {
      const legendTop = H - legendH + 4;
      const colW = W / 2;
      ctx.font = "13px sans-serif";
      ctx.textBaseline = "middle";
      segments.forEach((s, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const lx  = 8 + col * colW;
        const ly  = legendTop + row * 14;
        ctx.fillStyle = s.color;
        ctx.fillRect(lx, ly - 4, 8, 8);
        ctx.fillStyle = textColor;
        ctx.textAlign = "left";
        const lbl = s.name.length > 18 ? s.name.slice(0, 16) + "\u2026" : s.name;
        ctx.fillText(`${lbl} (${Math.round(s.pct * 100)}%)`, lx + 11, ly);
      });
    }
    return { pie: segments, bar: [] };
  }

  // ── BAR ─────────────────────────────────────────────────────────────────
  const allItems = [...entries].sort((a, b) => b.value - a.value);
  const n = allItems.length;
  if (n === 0) return { pie: [], bar: [] };

  const maxPos = posItems.length ? Math.max(...posItems.map((e) => e.value)) : 0;
  const maxNeg = negItems.length ? Math.max(...negItems.map((e) => -e.value)) : 0;

  const padL = expanded ? 56 : 4;
  const padR = expanded ? 12 : 4;
  const padT = expanded ? 16 : 6;
  const padB = expanded ? 28 : 4;

  const chartW  = W - padL - padR;
  const chartH  = H - padT - padB;
  const total   = (maxPos || 1) + (maxNeg || 0);
  const posZone = maxPos > 0 ? (maxPos / total) * chartH : 0;
  const negZone = maxNeg > 0 ? (maxNeg / total) * chartH : 0;
  const baseY   = padT + posZone;

  const gap  = Math.max(2, Math.floor(chartW / n * 0.15));
  const barW = (chartW - gap * (n - 1)) / n;

  if (expanded) {
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + chartH);
    ctx.moveTo(padL, baseY);
    ctx.lineTo(padL + chartW, baseY);
    ctx.stroke();

    ctx.font = "12px sans-serif";
    ctx.fillStyle = textColor;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
      const val = (maxPos * t) / ticks;
      const ty  = baseY - (posZone * t) / ticks;
      ctx.fillText("$" + Math.round(val), padL - 3, ty);
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(padL - 2, ty);
      ctx.lineTo(padL + chartW, ty);
      ctx.stroke();
    }
    if (maxNeg > 0) {
      for (let t = 1; t <= 2; t++) {
        const val = -(maxNeg * t) / 2;
        const ty  = baseY + (negZone * t) / 2;
        ctx.fillStyle = textColor;
        ctx.textAlign = "right";
        ctx.fillText("$" + Math.round(val), padL - 3, ty);
      }
    }
  }

  const segments: BarSegment[] = [];
  allItems.forEach((e, i) => {
    const isNeg  = e.value < 0;
    const absVal = Math.abs(e.value);
    const h      = isNeg
      ? (maxNeg > 0 ? (absVal / maxNeg) * negZone : 0)
      : (maxPos > 0 ? (absVal / maxPos) * posZone : 0);
    const x    = padL + i * (barW + gap);
    const y    = isNeg ? baseY : baseY - h;
    const pct  = (!isNeg && posTotal > 0) ? e.value / posTotal : null;
    const color = palette[i % palette.length];
    const r2   = Math.min(3, barW / 2);

    ctx.fillStyle = isNeg ? color + "88" : color;
    ctx.beginPath();
    if (isNeg) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + barW, y);
      ctx.lineTo(x + barW, y + h - r2);
      ctx.quadraticCurveTo(x + barW, y + h, x + barW - r2, y + h);
      ctx.lineTo(x + r2, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r2);
      ctx.lineTo(x, y);
    } else {
      ctx.moveTo(x + r2, y);
      ctx.lineTo(x + barW - r2, y);
      ctx.quadraticCurveTo(x + barW, y, x + barW, y + r2);
      ctx.lineTo(x + barW, y + h);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x, y + r2);
      ctx.quadraticCurveTo(x, y, x + r2, y);
    }
    ctx.closePath();
    ctx.fill();

    if (expanded && barW > 10) {
      ctx.save();
      ctx.translate(x + barW / 2, baseY + (isNeg ? 4 : 4));
      ctx.rotate(Math.PI / 5);
      ctx.fillStyle = textColor;
      ctx.font = "11px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const lbl = e.name.length > 12 ? e.name.slice(0, 10) + "\u2026" : e.name;
      ctx.fillText(lbl, 0, 0);
      ctx.restore();
    }
    segments.push({ name: e.name, value: e.value, pct, x, y, w: barW, h, color, isNeg });
  });
  return { pie: [], bar: segments };
}

/* ── Tooltip ─────────────────────────────────────────────────────────────── */
let _tooltipTimer: ReturnType<typeof setTimeout> | null = null;
let _tooltipEl: HTMLDivElement | null = null;

function showChartTooltip(canvas: HTMLCanvasElement, label: string, mx: number, my: number): void {
  hideChartTooltip();
  const tip = document.createElement("div");
  tip.className = "budget-chart-tooltip";
  tip.textContent = label;
  document.body.appendChild(tip);
  _tooltipEl = tip;
  const rect = canvas.getBoundingClientRect();
  tip.style.left = Math.max(4, Math.min(rect.left + mx, window.innerWidth - 160)) + "px";
  tip.style.top  = Math.max(4, rect.top + my - 40) + "px";
}

function hideChartTooltip(): void {
  if (_tooltipTimer) { clearTimeout(_tooltipTimer); _tooltipTimer = null; }
  if (_tooltipEl)    { _tooltipEl.remove(); _tooltipEl = null; }
}

// Tracks the active AbortController for chart tooltip listeners so re-renders
// cleanly remove the previous listeners without cloning the canvas element.
const _chartTooltipAborts = new WeakMap<HTMLCanvasElement, AbortController>();

function attachChartTooltip(
  canvas: HTMLCanvasElement,
  result: { pie: PieSegment[]; bar: BarSegment[] },
  type: ChartType,
  showCost = false, // when true (modal), also show the dollar amount
): HTMLCanvasElement {
  _chartTooltipAborts.get(canvas)?.abort();
  const ac = new AbortController();
  _chartTooltipAborts.set(canvas, ac);
  const { signal } = ac;

  canvas.addEventListener("mousemove", (ev: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    if (_tooltipTimer) { clearTimeout(_tooltipTimer); _tooltipTimer = null; }
    let label: string | null = null;

    if (type === "pie") {
      for (const seg of result.pie) {
        const dx = mx - seg.cx, dy = my - seg.cy;
        if (dx * dx + dy * dy > seg.r * seg.r) continue;
        const norm = (v: number) => v < -Math.PI / 2 ? v + Math.PI * 2 : v;
        const a = Math.atan2(dy, dx);
        const na = norm(a), ns = norm(seg.startAngle), ne = norm(seg.endAngle);
        if (na >= ns && na <= ne) {
          label = showCost
            ? `${seg.name}: ${formatCurrency(seg.value)} (${Math.round(seg.pct * 100)}%)`
            : `${seg.name}: ${Math.round(seg.pct * 100)}%`;
          break;
        }
      }
    } else {
      for (const seg of result.bar) {
        if (mx >= seg.x && mx <= seg.x + seg.w && my >= seg.y && my <= seg.y + seg.h) {
          if (seg.isNeg) {
            label = showCost ? `${seg.name}: ${formatCurrency(seg.value)}` : seg.name;
          } else {
            label = showCost
              ? `${seg.name}: ${formatCurrency(seg.value)} (${Math.round((seg.pct ?? 0) * 100)}%)`
              : `${seg.name}: ${Math.round((seg.pct ?? 0) * 100)}%`;
          }
          break;
        }
      }
    }

    if (label) {
      _tooltipTimer = setTimeout(() => showChartTooltip(canvas, label!, mx, my), 500);
    } else {
      hideChartTooltip();
    }
  }, { signal });

  canvas.addEventListener("mouseleave", hideChartTooltip, { signal });
  return canvas;
}

/* ── Chart expand modal ──────────────────────────────────────────────────── */
let _chartModal: Modal | null = null;

function getChartModal(): Modal {
  if (!_chartModal) {
    _chartModal = new Modal(
      document.getElementById("budgetChartExpandBackdrop")!,
      { closeOnEsc: true },
    );
  }
  return _chartModal;
}

function buildChartEntries(grouping: "category" | "source"): ChartEntry[] {
  const expenses = data.fluctuatingExpenses.filter((e) => inRange(e.date, viewStart, viewEnd));
  const map = new Map<string, number>();
  for (const e of expenses) {
    if (grouping === "category") {
      const cat = getCategoryById(e.categoryId);
      if (cat?.excludeFromCharts) continue;
      const name = cat?.name ?? "(unknown)";
      map.set(name, (map.get(name) ?? 0) + e.amount);
    } else {
      const src = data.expenseSources.find((s) => s.name === e.description);
      if (src?.excludeFromCharts) continue;
      const name = e.description || "(no source)";
      map.set(name, (map.get(name) ?? 0) + e.amount);
    }
  }
  return [...map.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

// Tracks which grouping is currently open in the expand modal so the
// cycle button inside the modal knows what to toggle.
let _chartModalGrouping: "category" | "source" = "category";

function drawModalChart(): void {
  const grouping = _chartModalGrouping;
  const type = grouping === "category" ? categoryChartType : sourceChartType;
  const grpLabel  = grouping === "category" ? "Category" : "Source";
  const typeLabel = type === "bar" ? "Bar" : "Pie";

  // Keep title, subtitle, and cycle button label in sync
  (document.getElementById("budgetChartExpandTitle") as HTMLElement).textContent =
    `Expense by ${grpLabel}: ${typeLabel} Chart`;
  (document.getElementById("budgetChartExpandSubtitle") as HTMLElement).textContent =
    `${formatDate(viewStart)} – ${formatDate(viewEnd)}`;
  const cycleBtn = document.getElementById("budgetChartExpandCycleBtn") as HTMLButtonElement;
  cycleBtn.textContent = type === "bar" ? "Bar" : "Pie";

  const modalCanvas = document.getElementById("budgetChartExpandCanvas") as HTMLCanvasElement;
  const modalPanel  = document.getElementById("budgetChartExpandModal");
  if (!modalPanel) return;

  // Measure the modal panel (block element, reliable clientWidth).
  // Cap height so the chart fits on screen: viewport height minus header/subtitle/padding.
  const w = Math.max(0, (modalPanel.clientWidth || modalPanel.offsetWidth) - 40);
  const maxH = Math.max(200, window.innerHeight - 220);
  const h = Math.min(420, maxH);
  if (w <= 0) return;

  modalCanvas.style.width  = w + "px";
  modalCanvas.style.height = h + "px";
  modalCanvas.width  = w;
  modalCanvas.height = h;

  const entries = buildChartEntries(grouping);
  const result  = drawSummaryChart(modalCanvas, entries, type, true);
  attachChartTooltip(modalCanvas, result, type, true); // true = show cost in tooltip
}

function openChartModal(grouping: "category" | "source"): void {
  _chartModalGrouping = grouping;

  // Sync labels BEFORE opening
  const type = grouping === "category" ? categoryChartType : sourceChartType;
  const cycleBtn = document.getElementById("budgetChartExpandCycleBtn") as HTMLButtonElement;
  cycleBtn.textContent = type === "bar" ? "Bar" : "Pie";
  (document.getElementById("budgetChartExpandTitle") as HTMLElement).textContent =
    `Expense by ${grouping === "category" ? "Category" : "Source"}: ${type === "bar" ? "Bar" : "Pie"} Chart`;
  (document.getElementById("budgetChartExpandSubtitle") as HTMLElement).textContent =
    `${formatDate(viewStart)} – ${formatDate(viewEnd)}`;

  // Clear the canvas before opening so the old graph never shows during the
  // open transition. The new graph draws after the transition completes.
  const modalCanvas = document.getElementById("budgetChartExpandCanvas") as HTMLCanvasElement;
  const ctx = modalCanvas.getContext("2d");
  if (ctx) ctx.clearRect(0, 0, modalCanvas.width, modalCanvas.height);

  getChartModal().open();

  // Draw after transition completes (300ms covers the 250ms CSS transition)
  setTimeout(drawModalChart, 300);
}


/**
 * Sizes the canvas by measuring its column container, then calls draw().
 * canvas width:100% + aspect-ratio is unreliable for getting clientWidth.
 * Measures the summary panel (a concrete block element) and computes the
 * chart column's pixel width as 40% of that, then sets explicit canvas
 * dimensions and calls draw(). Runs in a setTimeout(0) so the panel's
 * block layout is committed even if flex children aren't measured yet.
 */
function drawWhenReady(
  canvas: HTMLCanvasElement,
  draw: (c: HTMLCanvasElement) => void,
): void {
  function sizeAndDraw(): void {
    // Walk up to the nearest panel, it's a block with a real clientWidth.
    const panel = canvas.closest<HTMLElement>(".panel");
    if (!panel) return;
    const panelW = panel.clientWidth || panel.offsetWidth;
    if (panelW <= 0) return;
    // Chart column is flex:3 in a flex:7+3 layout ≈ 30% minus gap and padding.
    // TUNING: if you change the CSS flex split, update the 0.3 fraction here too.
    // Cap at 260px matching the CSS max-width clamp to prevent overflow.
    const gap = 12;
    const raw = Math.floor((panelW - 24 - gap) * 0.3); // 24px = pane padding L+R
    const w = Math.min(raw, 260);
    if (w <= 0) return;
    canvas.style.width  = w + "px";
    canvas.style.height = w + "px";
    canvas.width  = w;
    canvas.height = w;
    draw(canvas);
  }

  // Always use setTimeout(0), gives the browser one full macrotask to commit
  // block layout on the panel before we measure it.
  setTimeout(sizeAndDraw, 0);
}

function renderCategorySummary(): void {
  categorySummaryEl.innerHTML = "";
  const expenses = data.fluctuatingExpenses.filter((e) =>
    inRange(e.date, viewStart, viewEnd),
  );

  // Update cycle button label to reflect current type
  const cycleBtn = document.getElementById("budgetCategoryChartCycleBtn") as HTMLButtonElement | null;
  if (cycleBtn) cycleBtn.textContent = categoryChartType === "bar" ? "Bar" : "Pie";

  if (expenses.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder-text";
    p.textContent = "No expense entries in this range.";
    categorySummaryEl.appendChild(p);
    const canvas = document.getElementById("budgetCategoryChart") as HTMLCanvasElement | null;
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  // Build table data (all entries, including negative)
  const map = new Map<string, { total: number; count: number; excluded: boolean }>();
  for (const e of expenses) {
    const cat = getCategoryById(e.categoryId);
    const name = cat?.name ?? "(unknown)";
    const excluded = !!(cat?.excludeFromCharts);
    const existing = map.get(name) ?? { total: 0, count: 0, excluded };
    map.set(name, { total: existing.total + e.amount, count: existing.count + 1, excluded });
  }
  const sorted = [...map.entries()].sort((a, b) => b[1].total - a[1].total);
  let grandTotal = 0;
  categorySummaryEl.appendChild(buildSummaryHeader("Category"));
  for (const [name, { total, count, excluded }] of sorted) {
    grandTotal += total;
    categorySummaryEl.appendChild(buildSummaryRow(name, count, total / count, -total, false, excluded));
  }
  categorySummaryEl.appendChild(buildSummaryRow("Total", 0, 0, -grandTotal, true));

  const catCanvas = document.getElementById("budgetCategoryChart") as HTMLCanvasElement | null;
  if (catCanvas) {
    const entries = buildChartEntries("category");
    drawWhenReady(catCanvas, (c) => {
      const result = drawSummaryChart(c, entries, categoryChartType);
      attachChartTooltip(c, result, categoryChartType);
    });
  }
}

function renderSourceSummary(): void {
  sourceSummaryEl.innerHTML = "";
  const expenses = data.fluctuatingExpenses.filter((e) =>
    inRange(e.date, viewStart, viewEnd),
  );

  const cycleBtn = document.getElementById("budgetSourceChartCycleBtn") as HTMLButtonElement | null;
  if (cycleBtn) cycleBtn.textContent = sourceChartType === "bar" ? "Bar" : "Pie";

  if (expenses.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder-text";
    p.textContent = "No expense entries in this range.";
    sourceSummaryEl.appendChild(p);
    const canvas = document.getElementById("budgetSourceChart") as HTMLCanvasElement | null;
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const map = new Map<string, { total: number; count: number; excluded: boolean }>();
  for (const e of expenses) {
    const src = data.expenseSources.find((s) => s.name === e.description);
    const name = e.description || "(no source)";
    const excluded = !!(src?.excludeFromCharts);
    const existing = map.get(name) ?? { total: 0, count: 0, excluded };
    map.set(name, { total: existing.total + e.amount, count: existing.count + 1, excluded });
  }
  const sorted = [...map.entries()].sort((a, b) => b[1].total - a[1].total);
  let grandTotal = 0;
  sourceSummaryEl.appendChild(buildSummaryHeader("Source"));
  for (const [name, { total, count, excluded }] of sorted) {
    grandTotal += total;
    sourceSummaryEl.appendChild(buildSummaryRow(name, count, total / count, -total, false, excluded));
  }
  sourceSummaryEl.appendChild(buildSummaryRow("Total", 0, 0, -grandTotal, true));

  const srcCanvas = document.getElementById("budgetSourceChart") as HTMLCanvasElement | null;
  if (srcCanvas) {
    const entries = buildChartEntries("source");
    drawWhenReady(srcCanvas, (c) => {
      const result = drawSummaryChart(c, entries, sourceChartType);
      attachChartTooltip(c, result, sourceChartType);
    });
  }
}

/* =============================================================================
   EXPECTATIONS & THRESHOLDS  (4th Summary Panel tab)
   -----------------------------------------------------------------------------
   Income Source "Expectations" and Expense Category/Source "Thresholds" are
   always defined as a calendar-month figure. When browsing a Day/Week/Year
   range, that monthly figure is scaled to match the browsed period:
     • Month → ×1 (no scaling)
     • Year  → ×12 (always a full Jan–Dec calendar year in this app)
     • Week  → ×(7 / days in the month containing the browsed week's Monday)
     • Day   → ×(1 / days in the month containing the browsed day)
   This keeps the comparison calendar-accurate rather than using flat 30-day /
   4.33-week averages.

   Color rules:
     • Income Expectation: ≥100% earned → green. <100% in a current/future
       period (viewEnd hasn't passed yet) → yellow. <100% in a past period
       (viewEnd already elapsed) → red.
     • Expense Threshold: ≥100% spent → red. <100% but above the item's
       configured warning % → yellow. Below the warning % → green.
============================================================================= */

const EXPECT_COLOR_GREEN = "#00FF00";
const EXPECT_COLOR_YELLOW = "#FFFF00";
const EXPECT_COLOR_RED = "#FF0000";

/** Pure black/white contrast pick (vs. contrastTextColor's softened near-black/near-white), used
 *  for the percentage label stamped directly on a solid progress-bar fill color. */
function pureContrastColor(hex: string): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return "#ffffff";
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return L > 0.5 ? "#000000" : "#ffffff";
}

function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

/** Multiplier to scale a monthly Expectation/Threshold to the browsed view range. */
function computeExpectScaleFactor(): number {
  switch (viewMode) {
    case "month":
      return 1;
    case "year":
      return 12;
    case "week": {
      const d = parseDate(viewWeekStart);
      return 7 / daysInMonth(d.getFullYear(), d.getMonth());
    }
    case "day": {
      const d = new Date(viewYear, viewMonth, viewDay);
      return 1 / daysInMonth(d.getFullYear(), d.getMonth());
    }
  }
}

function buildExpectRow(
  label: string,
  amount: number,
  target: number,
  isThreshold: boolean,
  warningPct: number,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "budget-expect-row";

  const labelEl = document.createElement("div");
  labelEl.className = "budget-expect-row-label";
  labelEl.textContent = label;
  row.appendChild(labelEl);

  const pct = target > 0 ? amount / target : 0;

  let color: string;
  if (isThreshold) {
    if (pct >= 1) color = EXPECT_COLOR_RED;
    else if (pct > warningPct / 100) color = EXPECT_COLOR_YELLOW;
    else color = EXPECT_COLOR_GREEN;
  } else {
    if (pct >= 1) color = EXPECT_COLOR_GREEN;
    else color = viewEnd < today() ? EXPECT_COLOR_RED : EXPECT_COLOR_YELLOW;
  }

  const statsRow = document.createElement("div");
  statsRow.className = "budget-expect-row-stats";

  const amountEl = document.createElement("span");
  amountEl.className = "budget-expect-row-amount";
  amountEl.textContent = `${formatCurrency(amount)} of ${formatCurrency(target)}`;
  statsRow.appendChild(amountEl);

  const track = document.createElement("div");
  track.className = "budget-expect-bar-track";
  const fill = document.createElement("div");
  fill.className = "budget-expect-bar-fill";
  fill.style.width = `${Math.min(100, Math.max(0, pct * 100))}%`;
  fill.style.background = color;
  track.appendChild(fill);

  const pctLabel = document.createElement("span");
  pctLabel.className = "budget-expect-bar-pct";
  pctLabel.textContent = `${Math.round(pct * 100)}%`;
  pctLabel.style.color = pureContrastColor(color);
  track.appendChild(pctLabel);
  statsRow.appendChild(track);

  row.appendChild(statsRow);
  return row;
}

function renderExpectSummary(): void {
  const container = document.getElementById("budgetExpectSummary") as HTMLElement;
  if (!container) return;
  container.innerHTML = "";

  const factor = computeExpectScaleFactor();

  const incomeRows = data.incomeSources.filter(
    (s) => s.status === "active" && s.expectationEnabled && (s.expectation ?? 0) > 0,
  );
  const catRows = data.categories.filter(
    (c) => c.status === "active" && c.thresholdEnabled && (c.threshold ?? 0) > 0,
  );
  const srcRows = data.expenseSources.filter(
    (s) => s.status === "active" && s.thresholdEnabled && (s.threshold ?? 0) > 0,
  );

  if (incomeRows.length === 0 && catRows.length === 0 && srcRows.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder-text";
    p.textContent =
      "No Expectations or Thresholds set yet. Configure them per item in Setup.";
    container.appendChild(p);
    return;
  }

  for (const src of incomeRows) {
    const earned = data.incomeEntries
      .filter((e) => e.sourceId === src.id && inRange(e.date, viewStart, viewEnd))
      .reduce((sum, e) => sum + e.actual, 0);
    const target = (src.expectation ?? 0) * factor;
    container.appendChild(
      buildExpectRow(`Income Source: ${src.name}`, earned, target, false, 0),
    );
  }

  for (const cat of catRows) {
    const spent = data.fluctuatingExpenses
      .filter((e) => e.categoryId === cat.id && inRange(e.date, viewStart, viewEnd))
      .reduce((sum, e) => sum + e.amount, 0);
    const target = (cat.threshold ?? 0) * factor;
    container.appendChild(
      buildExpectRow(
        `Expense Category: ${cat.name}`,
        spent,
        target,
        true,
        cat.thresholdWarningPct ?? 80,
      ),
    );
  }

  for (const src of srcRows) {
    const spent = data.fluctuatingExpenses
      .filter((e) => e.description === src.name && inRange(e.date, viewStart, viewEnd))
      .reduce((sum, e) => sum + e.amount, 0);
    const target = (src.threshold ?? 0) * factor;
    container.appendChild(
      buildExpectRow(
        `Expense Source: ${src.name}`,
        spent,
        target,
        true,
        src.thresholdWarningPct ?? 80,
      ),
    );
  }
}

function renderTotals(): void {
  const t = computeTotals(viewStart, viewEnd);
  totalsEl.innerHTML = "";

  const rows: [string, number][] = [
    ["Income", t.income],
    ["Total Recurring", -t.totalRecurring],
    ["  • Fixed Recurring", -t.fixedRecurring],
    ["  • Variable Recurring", -t.variableRecurring],
    ["Fluctuating Expenses", -t.fluctuating],
  ];

  for (const [label, value] of rows) {
    const row = buildTotalRow(label, value);
    if (label.startsWith("  ")) row.classList.add("budget-total-row-indent");
    totalsEl.appendChild(row);
  }

  const netRow = buildTotalRow("Net", t.net);
  netRow.classList.add("budget-total-net");
  totalsEl.appendChild(netRow);

  // Re-render the active summary breakdown tab if it's visible
  if (activeSummaryTab === "category") renderCategorySummary();
  if (activeSummaryTab === "source") renderSourceSummary();
  if (activeSummaryTab === "expect") renderExpectSummary();
}

/* =============================================================================
   ANNUAL STATS
   ---------------------------------------------------------------------------
   Computes and renders the full-year summary for viewYear. Mirrors the
   YEAR_SUMMARY sheet from the original Excel workbook:
     • Year at a Glance (totals + bill payment counts)
     • Income Summary by Source (expected, actual, delta, monthly avg)
     • Recurring Bills Summary (planned, paid YTD, late payments)
     • Fluctuating Expenses by Category (charges, total, monthly avg, avg charge, highest, highest month)
     • Fluctuating Expenses by Source (same columns, new vs. Excel)
     • Month by Month (all totals + averages row)
============================================================================= */

function computeAnnualStats(year: number) {
  const yStart = `${year}-01-01`;
  const yEnd = `${year}-12-31`;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function monthStart(m: number) {
    return `${year}-${String(m + 1).padStart(2, "0")}-01`;
  }
  function monthEnd(m: number) {
    const last = new Date(year, m + 1, 0);
    return `${year}-${String(m + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`;
  }

  // Monthly averages are divided by the number of months elapsed so far when
  // viewing the current year (e.g. ÷7 in July), and by all 12 months for any
  // past (completed) year.
  const now = new Date();
  const monthDivisor = year === now.getFullYear() ? now.getMonth() + 1 : 12;

  // ── Year-level totals ────────────────────────────────────────────────────

  const totals = computeTotals(yStart, yEnd);

  // Bill payment counts (paid on time, paid late, overdue active bills)
  let paidOnTime = 0,
    paidLate = 0;
  for (const inst of data.billInstances) {
    if (!inRange(inst.dueDate, yStart, yEnd)) continue;
    if (inst.paidDate > inst.dueDate) paidLate++;
    else paidOnTime++;
  }
  // Overdue = active bills whose nextDue falls in this year and are unpaid
  const overdueBills = getActiveBills().filter(
    (b) => b.nextDue >= yStart && b.nextDue <= yEnd && b.nextDue < today(),
  ).length;

  // ── Income by Source ─────────────────────────────────────────────────────

  const incomeBySource: { name: string; expected: number; actual: number }[] =
    [];
  for (const src of data.incomeSources) {
    const entries = data.incomeEntries.filter(
      (e) => e.sourceId === src.id && inRange(e.date, yStart, yEnd),
    );
    if (entries.length === 0) continue;
    incomeBySource.push({
      name: src.name,
      expected: entries.reduce((s, e) => s + e.expected, 0),
      actual: entries.reduce((s, e) => s + e.actual, 0),
    });
  }
  // Also catch entries whose sourceId no longer exists in incomeSources
  const knownSourceIds = new Set(data.incomeSources.map((s) => s.id));
  const orphanEntries = data.incomeEntries.filter(
    (e) => !knownSourceIds.has(e.sourceId) && inRange(e.date, yStart, yEnd),
  );
  if (orphanEntries.length > 0) {
    incomeBySource.push({
      name: "(unknown source)",
      expected: orphanEntries.reduce((s, e) => s + e.expected, 0),
      actual: orphanEntries.reduce((s, e) => s + e.actual, 0),
    });
  }

  // ── Recurring Bills ──────────────────────────────────────────────────────

  const billStats: {
    name: string;
    billType: BillType;
    planned: number;
    paid: number;
    lateCount: number;
  }[] = [];
  for (const bill of data.recurringBills) {
    const instances = data.billInstances.filter(
      (i) => i.billId === bill.id && inRange(i.dueDate, yStart, yEnd),
    );
    if (instances.length === 0 && bill.status === "retired") continue;
    const planned = instances.reduce((s, i) => s + (i.plannedAmount ?? 0), 0);
    const paid = instances.reduce((s, i) => s + i.actualAmount, 0);
    const lateCount = instances.filter((i) => i.paidDate > i.dueDate).length;
    if (instances.length === 0 && paid === 0 && planned === 0) continue;
    billStats.push({
      name: bill.name,
      billType: bill.billType,
      planned,
      paid,
      lateCount,
    });
  }

  // ── Fluctuating Expenses by Category ────────────────────────────────────

  const yearExpenses = data.fluctuatingExpenses.filter((e) =>
    inRange(e.date, yStart, yEnd),
  );

  function buildExpenseGroupStats<K extends string>(
    getKey: (e: FluctuatingExpense) => K,
    getName: (key: K) => string,
  ) {
    const map = new Map<K, FluctuatingExpense[]>();
    for (const e of yearExpenses) {
      const k = getKey(e);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(e);
    }
    return [...map.entries()]
      .map(([key, items]) => {
        const total = items.reduce((s, e) => s + e.amount, 0);
        const charges = items.length;
        let highest = 0;
        let highestMonth = -1;
        for (const e of items) {
          const m = parseInt(e.date.slice(5, 7), 10) - 1;
          if (e.amount > highest) {
            highest = e.amount;
            highestMonth = m;
          }
        }
        const monthlyAvg = total / monthDivisor;
        return {
          name: getName(key),
          charges,
          total,
          monthlyAvg,
          avgCharge: charges > 0 ? total / charges : 0,
          highest,
          highestMonth,
        };
      })
      .sort((a, b) => b.total - a.total);
  }

  const byCategory = buildExpenseGroupStats(
    (e) => e.categoryId,
    (id) => getCategoryById(id)?.name ?? "(unknown)",
  );

  const bySource = buildExpenseGroupStats(
    (e) => e.description || "(no source)",
    (name) => name,
  );

  // ── Month by Month ────────────────────────────────────────────────────────

  const monthRows = MONTH_NAMES.map((monthName, m) => {
    const ms = monthStart(m);
    const me = monthEnd(m);

    // Check if there's any data for this month
    const hasIncome = data.incomeEntries.some((e) => inRange(e.date, ms, me));
    const hasExpense = data.fluctuatingExpenses.some((e) =>
      inRange(e.date, ms, me),
    );
    const hasBills = data.billInstances.some((i) => inRange(i.dueDate, ms, me));

    if (!hasIncome && !hasExpense && !hasBills) return null;

    const mt = computeTotals(ms, me);

    let onTime = 0,
      late = 0,
      overdue = 0;
    for (const inst of data.billInstances) {
      if (!inRange(inst.dueDate, ms, me)) continue;
      if (inst.paidDate > inst.dueDate) late++;
      else onTime++;
    }
    // Overdue: active bills whose nextDue is in this month and before today
    overdue = getActiveBills().filter(
      (b) => inRange(b.nextDue, ms, me) && b.nextDue < today(),
    ).length;

    return {
      month: monthName.slice(0, 3).toUpperCase(),
      ...mt,
      onTime,
      late,
      overdue,
    };
  }).filter((r): r is NonNullable<typeof r> => r !== null);

  return {
    totals,
    monthDivisor,
    paidOnTime,
    paidLate,
    overdueBills,
    incomeBySource,
    billStats,
    byCategory,
    bySource,
    monthRows,
  };
}

function renderAnnualStats(): void {
  const year = viewYear;
  (
    document.getElementById("budgetAnnualStatsTitle") as HTMLElement
  ).textContent = `Annual Stats: ${year}`;

  const stats = computeAnnualStats(year);

  // ── Year at a Glance ────────────────────────────────────────────────────
  const overviewEl = document.getElementById("budgetAnnualOverview")!;
  overviewEl.innerHTML = "";
  const glanceRows: [string, number | string][] = [
    ["Total Income", stats.totals.income],
    ["Total Recurring Expenses", -stats.totals.totalRecurring],
    ["  • Fixed Recurring", -stats.totals.fixedRecurring],
    ["  • Variable Recurring", -stats.totals.variableRecurring],
    ["Total Fluctuating Expenses", -stats.totals.fluctuating],
    ["Annual Net", stats.totals.net],
  ];
  for (const [label, value] of glanceRows) {
    const row = buildTotalRow(label, value as number);
    if (label === "Annual Net") row.classList.add("budget-total-net");
    if (label.startsWith("  ")) row.classList.add("budget-total-row-indent");
    overviewEl.appendChild(row);
  }
  // Bill payment counts
  const countDiv = document.createElement("div");
  countDiv.className = "budget-stats-counts";
  countDiv.innerHTML = `
    <span class="budget-stats-count budget-stats-count-good">✓ ${stats.paidOnTime} on time</span>
    <span class="budget-stats-count budget-stats-count-late">⚠ ${stats.paidLate} late</span>
    <span class="budget-stats-count budget-stats-count-overdue">✗ ${stats.overdueBills} overdue</span>
  `;
  overviewEl.appendChild(countDiv);

  // ── Income Summary ───────────────────────────────────────────────────────
  const incomeBody = document.querySelector("#budgetAnnualIncomeTable tbody")!;
  incomeBody.innerHTML = "";
  let totalExp = 0,
    totalAct = 0;
  for (const src of stats.incomeBySource) {
    const delta = src.actual - src.expected;
    const monthlyAvg = src.actual / stats.monthDivisor;
    totalExp += src.expected;
    totalAct += src.actual;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(src.name)}</td>
      <td class="num">${formatCurrency(src.expected)}</td>
      <td class="num">${formatCurrency(src.actual)}</td>
      <td class="num ${delta >= 0 ? "pos" : "neg"}">${formatCurrency(delta)}</td>
      <td class="num">${formatCurrency(monthlyAvg)}</td>`;
    incomeBody.appendChild(tr);
  }
  if (stats.incomeBySource.length > 0) {
    const totalDelta = totalAct - totalExp;
    const tr = document.createElement("tr");
    tr.className = "stats-total-row";
    tr.innerHTML = `<td>Total</td>
      <td class="num">${formatCurrency(totalExp)}</td>
      <td class="num">${formatCurrency(totalAct)}</td>
      <td class="num ${totalDelta >= 0 ? "pos" : "neg"}">${formatCurrency(totalDelta)}</td>
      <td class="num">${formatCurrency(totalAct / stats.monthDivisor)}</td>`;
    incomeBody.appendChild(tr);
  }

  // ── Recurring Bills ──────────────────────────────────────────────────────
  const billsBody = document.querySelector("#budgetAnnualBillsTable tbody")!;
  billsBody.innerHTML = "";
  let totalPlanned = 0,
    totalPaid = 0,
    totalLate = 0;
  for (const b of stats.billStats) {
    totalPlanned += b.planned;
    totalPaid += b.paid;
    totalLate += b.lateCount;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(b.name)}</td>
      <td>${b.billType === "fixed" ? "Fixed" : "Variable"}</td>
      <td class="num">${formatCurrency(b.planned)}</td>
      <td class="num">${formatCurrency(b.paid)}</td>
      <td class="num ${b.lateCount > 0 ? "neg" : ""}">${b.lateCount}</td>`;
    billsBody.appendChild(tr);
  }
  if (stats.billStats.length > 0) {
    const tr = document.createElement("tr");
    tr.className = "stats-total-row";
    tr.innerHTML = `<td>Total</td><td></td>
      <td class="num">${formatCurrency(totalPlanned)}</td>
      <td class="num">${formatCurrency(totalPaid)}</td>
      <td class="num ${totalLate > 0 ? "neg" : ""}">${totalLate}</td>`;
    billsBody.appendChild(tr);
  }

  // ── Expense group table helper ────────────────────────────────────────────
  function fillExpenseTable(
    tableId: string,
    groups: ReturnType<typeof computeAnnualStats>["byCategory"],
  ) {
    const body = document.querySelector(`#${tableId} tbody`)!;
    body.innerHTML = "";
    let totTotal = 0,
      totCharges = 0;
    for (const g of groups) {
      totTotal += g.total;
      totCharges += g.charges;
      const monthLabel =
        g.highestMonth >= 0 ? MONTH_NAMES[g.highestMonth].slice(0, 3) : "—";
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(g.name)}</td>
        <td class="num">${g.charges}</td>
        <td class="num">${formatCurrency(g.total)}</td>
        <td class="num">${formatCurrency(g.monthlyAvg)}</td>
        <td class="num">${formatCurrency(g.avgCharge)}</td>
        <td class="num">${g.highest > 0 ? formatCurrency(g.highest) : "—"}</td>
        <td>${monthLabel}</td>`;
      body.appendChild(tr);
    }
    if (groups.length > 0) {
      const tr = document.createElement("tr");
      tr.className = "stats-total-row";
      tr.innerHTML = `<td>Total</td>
        <td class="num">${totCharges}</td>
        <td class="num">${formatCurrency(totTotal)}</td>
        <td class="num">${formatCurrency(totTotal / stats.monthDivisor)}</td>
        <td class="num"></td><td class="num"></td><td></td>`;
      body.appendChild(tr);
    }
  }

  fillExpenseTable("budgetAnnualCategoryTable", stats.byCategory);
  fillExpenseTable("budgetAnnualSourceTable", stats.bySource);

  // ── Month by Month ────────────────────────────────────────────────────────
  const monthBody = document.querySelector("#budgetAnnualMonthTable tbody")!;
  monthBody.innerHTML = "";
  document.getElementById("budgetAnnualMonthTotals")!.innerHTML = "";
  document.getElementById("budgetAnnualMonthAvgs")!.innerHTML = "";
  for (const r of stats.monthRows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.month}</td>
      <td class="num">${formatCurrency(r.income)}</td>
      <td class="num">${formatCurrency(-r.totalRecurring)}</td>
      <td class="num">${formatCurrency(-r.fixedRecurring)}</td>
      <td class="num">${formatCurrency(-r.variableRecurring)}</td>
      <td class="num">${formatCurrency(-r.fluctuating)}</td>
      <td class="num ${r.net >= 0 ? "pos" : "neg"}">${formatCurrency(r.net)}</td>
      <td class="num">${r.onTime}</td>
      <td class="num ${r.late > 0 ? "neg" : ""}">${r.late}</td>
      <td class="num ${r.overdue > 0 ? "neg" : ""}">${r.overdue}</td>`;
    monthBody.appendChild(tr);
  }

  // Totals and averages rows
  if (stats.monthRows.length > 0) {
    const sum = (fn: (r: (typeof stats.monthRows)[0]) => number) =>
      stats.monthRows.reduce((s, r) => s + fn(r), 0);
    const avg = (fn: (r: (typeof stats.monthRows)[0]) => number) =>
      sum(fn) / stats.monthDivisor;

    const totalsRow = document.getElementById("budgetAnnualMonthTotals")!;
    totalsRow.className = "stats-total-row";
    totalsRow.innerHTML = `<td>Total</td>
      <td class="num">${formatCurrency(sum((r) => r.income))}</td>
      <td class="num">${formatCurrency(sum((r) => -r.totalRecurring))}</td>
      <td class="num">${formatCurrency(sum((r) => -r.fixedRecurring))}</td>
      <td class="num">${formatCurrency(sum((r) => -r.variableRecurring))}</td>
      <td class="num">${formatCurrency(sum((r) => -r.fluctuating))}</td>
      <td class="num">${formatCurrency(sum((r) => r.net))}</td>
      <td class="num">${sum((r) => r.onTime)}</td>
      <td class="num">${sum((r) => r.late)}</td>
      <td class="num">${sum((r) => r.overdue)}</td>`;

    const avgsRow = document.getElementById("budgetAnnualMonthAvgs")!;
    avgsRow.className = "stats-avg-row";
    avgsRow.innerHTML = `<td>Avg/Mo</td>
      <td class="num">${formatCurrency(avg((r) => r.income))}</td>
      <td class="num">${formatCurrency(avg((r) => -r.totalRecurring))}</td>
      <td class="num">${formatCurrency(avg((r) => -r.fixedRecurring))}</td>
      <td class="num">${formatCurrency(avg((r) => -r.variableRecurring))}</td>
      <td class="num">${formatCurrency(avg((r) => -r.fluctuating))}</td>
      <td class="num">${formatCurrency(avg((r) => r.net))}</td>
      <td class="num">${avg((r) => r.onTime).toFixed(1)}</td>
      <td class="num">${avg((r) => r.late).toFixed(1)}</td>
      <td class="num">${avg((r) => r.overdue).toFixed(1)}</td>`;
  }
}

/** Toggles between Annual Stats view and the main tool panels. */
// The view mode the user was in before entering Annual Stats, restored on exit.
let _preStatsViewMode: ViewMode | null = null;

function toggleAnnualStats(): void {
  const btn = document.getElementById(
    "budgetAnnualStatsBtn",
  ) as HTMLButtonElement;
  const flipCard = document.getElementById("budgetFlipCard")!;
  const front = flipCard.querySelector<HTMLElement>(".budget-flip-front")!;
  const back = flipCard.querySelector<HTMLElement>(".budget-flip-back")!;
  const viewModeBtnsAll = document.querySelectorAll<HTMLButtonElement>(
    ".budget-view-mode-btn",
  );

  const HALF = 400; // ms, matches the CSS animation duration

  // Prevent double-clicks mid-transition
  if (flipCard.dataset.flipping === "1") return;
  flipCard.dataset.flipping = "1";

  annualStatsVisible = !annualStatsVisible;

  btn.textContent = annualStatsVisible ? "View Main Tool" : "View Annual Stats";
  viewModeBtnsAll.forEach((b) => {
    b.classList.toggle(
      "budget-view-mode-btn-disabled",
      annualStatsVisible && b.dataset.view !== "year",
    );
  });

  if (annualStatsVisible && viewMode !== "year") {
    // Save the current mode so we can restore it when leaving Annual Stats
    _preStatsViewMode = viewMode;
    setViewMode("year");
  } else if (!annualStatsVisible && _preStatsViewMode !== null) {
    // Restore the view mode the user was in before entering Annual Stats
    setViewMode(_preStatsViewMode);
    _preStatsViewMode = null;
  }

  // The outgoing face fades out. At the midpoint (when opacity has reached 0),
  // we hide it, show the incoming face, and fade it in. Only one face is ever
  // in normal flow, so container height is always exact. No gap possible.
  const outgoing = annualStatsVisible ? front : back;
  const incoming = annualStatsVisible ? back : front;

  // Render stats content before it becomes visible
  if (annualStatsVisible) renderAnnualStats();

  // Phase 1: fade out the current face
  outgoing.classList.add("budget-face-hiding");

  window.setTimeout(() => {
    // Midpoint: swap which face is in the DOM flow
    outgoing.classList.remove("budget-face-hiding");
    outgoing.style.display = "none";
    incoming.style.display = "flex";

    // Phase 2: fade in the incoming face
    incoming.classList.add("budget-face-showing");

    incoming.addEventListener("animationend", function done() {
      incoming.removeEventListener("animationend", done);
      incoming.classList.remove("budget-face-showing");
      delete flipCard.dataset.flipping;
    });
  }, HALF);
}


const BILL_STATUS_LABEL: Record<BillRowKind, string> = {
  paid: "Paid",
  pending: "Pending",
  overdue: "Overdue",
};

function buildBillRow(row: BillRow): HTMLElement {
  const el = document.createElement("div");

  let colorClass = `budget-bill-${row.kind}`;
  if (row.kind === "paid") {
    const wasLate = row.instance!.paidDate > row.dueDate;
    colorClass = wasLate ? "budget-bill-paid-late" : "budget-bill-paid-ontime";
  }
  el.className = `budget-bill-row ${colorClass}${appSettings.showCleared ? "" : " budget-bill-row-no-cleared"}`;
  el.title =
    row.kind === "paid"
      ? "Click to view/edit this payment"
      : "Click to mark as paid";
  el.addEventListener("click", () => openBillAction(row));

  // Column 1: name
  const name = document.createElement("span");
  name.className = "budget-bill-name";
  name.textContent = row.bill.name;
  el.appendChild(name);

  // Column 2: Due date, always shown
  const dueCol = document.createElement("span");
  dueCol.className = "budget-bill-date-col";
  dueCol.innerHTML = `<span class="budget-bill-date-label">Due</span>${formatDate(row.dueDate)}`;
  el.appendChild(dueCol);

  // Column 3: Paid date, shown for paid rows, placeholder dash for others
  const paidCol = document.createElement("span");
  paidCol.className = "budget-bill-date-col";
  if (row.kind === "paid") {
    paidCol.innerHTML = `<span class="budget-bill-date-label">Paid</span>${formatDate(row.instance!.paidDate)}`;
  } else {
    paidCol.innerHTML = `<span class="budget-bill-date-label">Paid</span><span style="opacity:0.3">—</span>`;
  }
  el.appendChild(paidCol);

  // Column 4: Cleared date, only rendered when the setting is on
  if (appSettings.showCleared) {
    const clearedCol = document.createElement("span");
    clearedCol.className = "budget-bill-date-col";
    if (
      row.kind === "paid" &&
      row.instance!.cleared &&
      row.instance!.clearedDate
    ) {
      clearedCol.innerHTML = `<span class="budget-bill-date-label">Cleared</span>${formatDate(row.instance!.clearedDate)}`;
    } else if (row.kind === "paid" && row.instance!.cleared) {
      clearedCol.innerHTML = `<span class="budget-bill-date-label">Cleared</span>✓`;
    } else {
      clearedCol.innerHTML = `<span class="budget-bill-date-label">Cleared</span><span style="opacity:0.3">—</span>`;
    }
    el.appendChild(clearedCol);
  }

  // Column 5: Amount
  const amount = document.createElement("span");
  amount.className = "budget-bill-amount";
  const amountValue =
    row.kind === "paid" ? row.instance!.actualAmount : row.bill.amount;
  amount.textContent = amountValue === null ? "—" : formatCurrency(amountValue);
  el.appendChild(amount);

  // Column 6: Status badge
  const status = document.createElement("span");
  status.className = "budget-bill-status";
  if (row.kind === "paid") {
    const inst = row.instance!;
    const wasLate = inst.paidDate > row.dueDate;
    let label = wasLate ? "Paid Late" : "Paid";
    if (appSettings.showCleared && inst.cleared) label += " · Cleared";
    status.textContent = label;
  } else {
    status.textContent = BILL_STATUS_LABEL[row.kind];
  }
  el.appendChild(status);

  return el;
}

function renderBills(): void {
  const rows = getBillRowsForRange(viewStart, viewEnd);
  billsEl.innerHTML = "";

  if (rows.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder-text";
    p.textContent =
      "No recurring bills configured yet. Set these up in Manage Recurring Bills.";
    billsEl.appendChild(p);
  } else {
    for (const row of rows) {
      billsEl.appendChild(buildBillRow(row));
    }
  }

  const overdue = getOverdueBills();
  if (overdue.length > 0) {
    overdueBadgeEl.textContent =
      overdue.length === 1 ? "1 overdue" : `${overdue.length} overdue`;
    overdueBadgeEl.style.display = "";
  } else {
    overdueBadgeEl.style.display = "none";
  }
}

function makeCalBtn(
  item: LedgerItem & { kind: "income" | "expense" },
): HTMLButtonElement {
  const calBtn = document.createElement("button");
  calBtn.className = "entry-cal-btn";
  calBtn.textContent = "📅";
  calBtn.title = "Edit date";
  calBtn.addEventListener("click", () => {
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.value =
      item.kind === "income" ? item.entry.date : item.entry.date;
    dateInput.className = "entry-date-picker";
    calBtn.replaceWith(dateInput);
    dateInput.focus();
    dateInput.showPicker?.();

    function commitDate() {
      if (dateInput.value) {
        if (item.kind === "income") item.entry.date = dateInput.value;
        else item.entry.date = dateInput.value;
        queueSave();
        renderAll();
        flash("Date updated", "success");
      } else {
        renderEntries();
      }
    }

    dateInput.addEventListener("change", commitDate);
    dateInput.addEventListener("blur", () => renderEntries());
  });
  return calBtn;
}

function makeDeleteBtn(
  kind: "income" | "expense",
  id: string,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = "🗑️";
  btn.className = "entry-delete-btn";
  btn.title = "Delete entry";
  btn.addEventListener("click", () => {
    if (appSettings.quickDelete) {
      // Skip the confirm modal, delete immediately
      pendingDelete = { kind, id };
      confirmDelete();
    } else {
      openDeleteModal(kind, id);
    }
  });
  return btn;
}

/* =============================================================================
   LEDGER: INLINE EDITING
   -----------------------------------------------------------------------------
   Double-click any editable cell to edit in place. Enter or Tab commits the
   edit; Escape discards it. Category/income-source/expense-source edits resolve through
   the same findOrCreate* quick-add helpers as the Add Entry form, so a typo
   fix can either match an existing item or quietly create a new one.
============================================================================= */

type LedgerColumn = "category" | "name" | "amount" | "notes";

function makeLedgerEditable(
  span: HTMLElement,
  item: LedgerItem,
  column: LedgerColumn,
): void {
  const original = span.textContent || "";

  const input = document.createElement("input");
  input.className = "entry-edit-input";

  if (column === "amount") {
    input.type = "number";
    input.step = "0.01";
    // Pull the raw number from the entry, not the formatted display text
    let rawAmount: number;
    if (item.kind === "income") rawAmount = item.entry.actual;
    else if (item.kind === "expense") rawAmount = item.entry.amount;
    else rawAmount = item.instance.actualAmount;
    input.value = String(rawAmount);
  } else {
    input.type = "text";
    input.value = original === "—" ? "" : original;
    if (column === "category") {
      input.setAttribute("list", "budgetCategoryList");
    } else if (column === "name") {
      input.setAttribute(
        "list",
        item.kind === "income" ? "budgetSourceList" : "budgetExpenseSourceList",
      );
    }
  }

  input.style.width = Math.max(span.offsetWidth, 80) + "px";
  span.replaceWith(input);
  input.focus();
  input.select();

  let handled = false;

  function commit(): void {
    const raw = input.value.trim();

    if (column === "amount") {
      const num = parseFloat(raw);
      if (isNaN(num)) {
        cancel();
        return;
      }
      if (item.kind === "income") item.entry.actual = num;
      else if (item.kind === "expense") item.entry.amount = num;
      // bill rows aren't inline-editable. They open the Pay modal on click
    } else if (column === "category") {
      if (!raw || item.kind !== "expense") {
        cancel();
        return;
      }
      item.entry.categoryId = findOrCreateCategory(raw);
    } else if (column === "name") {
      if (!raw) {
        cancel();
        return;
      }
      if (item.kind === "income") {
        item.entry.sourceId = findOrCreateIncomeSource(raw);
      } else if (item.kind === "expense") {
        item.entry.description = raw;
        findOrCreateExpenseSource(raw);
      }
    } else {
      // notes, empty is a valid value (clears the note)
      if (item.kind === "income") item.entry.notes = raw;
      else if (item.kind === "expense") item.entry.notes = raw;
      // bill rows: not editable inline
    }

    queueSave();
    refreshDatalists();
    renderTotals();
    renderEntries();
    flash("Entry updated", "success");
  }

  function cancel(): void {
    renderEntries();
    flash("Edit discarded", "error");
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      handled = true;
      commit();
    } else if (e.key === "Escape") {
      handled = true;
      cancel();
    }
  });

  input.addEventListener("blur", () => {
    if (handled) return;
    commit();
  });
}

/**
 * Ledger rows share one column layout regardless of entry type:
 *   1. Category:   expense category name, or bill name (bold), or ", " for income
 *   2. Name:        income source, expense source text, or bill pay method
 *   3. Amount:      e.actual for income, e.amount for expense, inst.actualAmount for bill
 *   4. Notes
 *   5. Delete (income/expense only, bills use the Pay modal for edits)
 */
function buildLedgerRow(item: LedgerItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "entry-row";

  // Item 2: direction-aware exact colors (not theme variables).
  // Income where actual >= expected = money in = green.
  // Income where actual < expected = shortfall = red.
  // Expense amount > 0 = money out = red.
  // Expense amount <= 0 = credit/refund = green.
  // Bill payments are always money out = red.
  if (item.kind === "income") {
    row.classList.add(
      item.entry.actual >= 0
        ? "budget-row-income-positive"
        : "budget-row-income-negative",
    );
  } else if (item.kind === "expense") {
    row.classList.add(
      item.entry.amount > 0
        ? "budget-row-expense-positive"
        : "budget-row-expense-negative",
    );
  } else {
    row.classList.add("budget-row-bill");
  }

  const category = document.createElement("span");
  category.className = "entry-col-category";

  const name = document.createElement("span");
  name.className = "entry-field entry-col-name";

  const amount = document.createElement("span");
  amount.className = "entry-field entry-col-amount";

  const notes = document.createElement("span");
  notes.className = "entry-field entry-col-notes";

  // 5th column: action buttons. Always present so every row (including
  // read-only bill payments, which have no buttons) occupies the same
  // five grid cells and stays aligned with the rest of the ledger.
  const actions = document.createElement("span");
  actions.className = "entry-col-actions";

  if (item.kind === "income") {
    const e = item.entry;
    category.textContent = "Income";

    name.title = "Double-click to edit";
    name.textContent = getIncomeSourceById(e.sourceId)?.name ?? "(unknown)";
    name.addEventListener("dblclick", () =>
      makeLedgerEditable(name, item, "name"),
    );

    amount.textContent = formatCurrency(e.actual);
    amount.title =
      e.actual !== e.expected
        ? `Expected ${formatCurrency(e.expected)}, double-click to edit`
        : "Double-click to edit";
    amount.addEventListener("dblclick", () =>
      makeLedgerEditable(amount, item, "amount"),
    );

    notes.title = "Double-click to edit";
    notes.textContent = e.notes;
    notes.addEventListener("dblclick", () =>
      makeLedgerEditable(notes, item, "notes"),
    );

    actions.append(makeCalBtn(item), makeDeleteBtn("income", e.id));
    row.append(category, name, amount, notes, actions);
  } else if (item.kind === "expense") {
    const e = item.entry;
    category.className = "entry-field entry-col-category";
    category.title = "Double-click to edit";
    category.textContent = getCategoryById(e.categoryId)?.name ?? "(unknown)";
    category.addEventListener("dblclick", () =>
      makeLedgerEditable(category, item, "category"),
    );

    name.title = "Double-click to edit";
    name.textContent = e.description;
    name.addEventListener("dblclick", () =>
      makeLedgerEditable(name, item, "name"),
    );

    amount.textContent = formatCurrency(e.amount);
    amount.title = "Double-click to edit";
    amount.addEventListener("dblclick", () =>
      makeLedgerEditable(amount, item, "amount"),
    );

    notes.title = "Double-click to edit";
    notes.textContent = e.notes;
    notes.addEventListener("dblclick", () =>
      makeLedgerEditable(notes, item, "notes"),
    );

    actions.append(makeCalBtn(item), makeDeleteBtn("expense", e.id));
    row.append(category, name, amount, notes, actions);
  } else {
    // Bill payment, read-only in the ledger, click opens Pay modal
    const inst = item.instance;
    row.title = "Click to view/edit this payment";
    row.addEventListener("click", () => {
      // Build a synthetic BillRow to reuse openBillAction
      const billRow: BillRow = {
        bill: item.bill,
        kind: "paid",
        dueDate: inst.dueDate,
        instance: inst,
      };
      openBillAction(billRow);
    });

    category.className = "entry-col-category";
    category.textContent = "Recurring Bill";

    name.textContent = item.bill.name;
    name.title = `Due ${formatDate(inst.dueDate)} · Paid ${formatDate(inst.paidDate)}`;

    amount.textContent = formatCurrency(inst.actualAmount);

    notes.textContent = inst.notes;

    // No buttons for bill payments. The cell stays empty as a spacer
    // so the row still lines up with the other five-column rows.
    row.append(category, name, amount, notes, actions);
  }

  return row;
}

function renderEntries(): void {
  entriesEl.innerHTML = "";
  const items = getLedgerForRange(viewStart, viewEnd);

  if (items.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder-text";
    p.textContent = "No ledger entries yet for this month.";
    entriesEl.appendChild(p);
    return;
  }

  // `total` is optional so plain section labels (or any future subheader
  // that has no meaningful sum) can still be rendered without one. When
  // given, it's appended the same way Time Tracker appends its day total,
  // trailing the label on the same line.
  function appendSubheader(text: string, total?: number): void {
    const subheader = document.createElement("div");
    subheader.className = "entry-date-subheader";
    subheader.textContent =
      total === undefined ? text : `${text}: ${formatCurrency(total)}`;
    entriesEl.appendChild(subheader);
  }

  function itemDate(item: LedgerItem): string {
    return item.kind === "bill" ? item.instance.paidDate : item.entry.date;
  }

  /** Buckets an already-chronologically-sorted list of items by date,
   *  preserving order, used so every date subheader can carry a total. */
  function groupByDate(list: LedgerItem[]): Map<string, LedgerItem[]> {
    const map = new Map<string, LedgerItem[]>();
    for (const item of list) {
      const d = itemDate(item);
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(item);
    }
    return map;
  }

  /** Renders a date subheader (with net total) + rows for each date bucket
   *  in `list`. Shared by all three ledger view modes below. */
  function appendDateGroups(list: LedgerItem[]): void {
    for (const [date, groupItems] of groupByDate(list)) {
      appendSubheader(formatDate(date), sumNetAmount(groupItems));
      for (const item of groupItems) entriesEl.appendChild(buildLedgerRow(item));
    }
  }

  if (ledgerSortMode === "chrono") {
    // Default: purely chronological with date subheaders
    appendDateGroups(items);

  } else if (ledgerSortMode === "grouped") {
    // Income chronologically, then recurring bill payments chronologically,
    // then fluctuating expenses chronologically, three separate sections.
    const incomeItems = items.filter((i) => i.kind === "income");
    const billItems   = items.filter((i) => i.kind === "bill");
    const expenseItems = items.filter((i) => i.kind === "expense");

    if (incomeItems.length > 0) {
      appendSubheader("─── Income ───", sumNetAmount(incomeItems));
      appendDateGroups(incomeItems);
    }

    if (billItems.length > 0) {
      appendSubheader("─── Recurring Bills ───", sumNetAmount(billItems));
      appendDateGroups(billItems);
    }

    if (expenseItems.length > 0) {
      appendSubheader("─── Expenses ───", sumNetAmount(expenseItems));
      appendDateGroups(expenseItems);
    }

  } else {
    // Alpha-source: group by source name alphabetically, each group sorted chronologically
    // Source name: income source name, expense description/source, or bill name
    function sourceName(item: LedgerItem): string {
      if (item.kind === "income") return getIncomeSourceById(item.entry.sourceId)?.name ?? "(unknown)";
      if (item.kind === "expense") return item.entry.description || "(no source)";
      return item.bill.name;
    }

    const groups = new Map<string, LedgerItem[]>();
    for (const item of items) {
      const src = sourceName(item);
      if (!groups.has(src)) groups.set(src, []);
      groups.get(src)!.push(item);
    }

    const sortedGroups = [...groups.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );

    for (const [src, groupItems] of sortedGroups) {
      appendSubheader(src, sumNetAmount(groupItems));
      appendDateGroups(groupItems);
    }
  }
}

function renderAll(): void {
  renderTotals();
  renderBills();
  renderEntries();
  if (annualStatsVisible) renderAnnualStats();
}

/* =============================================================================
   MODAL: DELETE CONFIRM
============================================================================= */

function getDeleteModal(): Modal {
  if (!deleteModal) {
    deleteModal = new Modal(document.getElementById("budgetDeleteBackdrop")!, {
      closeOnEsc: true,
      onClosed: () => {
        pendingDelete = null;
      },
    });
    document
      .getElementById("budgetDeleteConfirmBtn")!
      .addEventListener("click", confirmDelete);
    document
      .getElementById("budgetDeleteCancelBtn")!
      .addEventListener("click", () => deleteModal!.close());
  }
  return deleteModal;
}

function openDeleteModal(kind: "income" | "expense", id: string): void {
  pendingDelete = { kind, id };

  // Build a specific description of what's being deleted
  let msg = "Are you sure you want to delete this entry?";
  if (kind === "income") {
    const entry = data.incomeEntries.find((e) => e.id === id);
    if (entry) {
      const source = getIncomeSourceById(entry.sourceId)?.name ?? "Unknown";
      msg = `Are you sure you want to delete this ${formatDate(entry.date)} income from ${source}?`;
    }
  } else {
    const entry = data.fluctuatingExpenses.find((e) => e.id === id);
    if (entry) {
      const cat = getCategoryById(entry.categoryId)?.name ?? "Unknown";
      const src = entry.description || null;
      // Format: "expense to {ExpenseSource} ({ExpenseCategory})"
      if (src) {
        msg = `Are you sure you want to delete this ${formatDate(entry.date)} expense to ${src} (${cat})?`;
      } else {
        msg = `Are you sure you want to delete this ${formatDate(entry.date)} expense (${cat})?`;
      }
    }
  }
  deleteMessageEl.textContent = msg;

  getDeleteModal().open();
}

function confirmDelete(): void {
  if (!pendingDelete) return;
  if (pendingDelete.kind === "income") {
    data.incomeEntries = data.incomeEntries.filter(
      (e) => e.id !== pendingDelete!.id,
    );
  } else {
    data.fluctuatingExpenses = data.fluctuatingExpenses.filter(
      (e) => e.id !== pendingDelete!.id,
    );
  }
  queueSave();
  renderTotals();
  renderEntries();
  getDeleteModal().close();
  flash("Entry deleted", "success");
}

/* =============================================================================
   MODAL: MARK BILL PAID / EDIT PAYMENT
   -----------------------------------------------------------------------------
   Clicking a pending/overdue bill row opens this in "pay" mode: enter the
   actual amount/date/cleared/notes, review (and optionally edit) the
   suggested next due date, and confirm. This records a BillInstance and
   advances the bill's nextDue.

   Clicking an already-paid row opens it in "edit" mode against that
   instance: amount/date/cleared/notes are editable, and "Undo Payment"
   removes the instance, restoring the bill to pending for that due date if
   no later payment has already moved nextDue past it.
============================================================================= */

type BillActionState =
  | { mode: "pay"; billId: string }
  | { mode: "edit"; billId: string; instanceId: string };

let activeBillAction: BillActionState | null = null;
let billActionModal: Modal | null = null;

function getBillActionModal(): Modal {
  if (!billActionModal) {
    billActionModal = new Modal(
      document.getElementById("budgetBillActionBackdrop")!,
      {
        closeOnEsc: true,
        onClosed: () => {
          activeBillAction = null;
        },
      },
    );
    billActionSaveBtn.addEventListener("click", saveBillAction);
    billActionUndoBtn.addEventListener("click", undoBillAction);
    billActionCancelBtn.addEventListener("click", () =>
      billActionModal!.close(),
    );
    billActionCloseBtn.addEventListener("click", () =>
      billActionModal!.close(),
    );
    // Item 7: toggle cleared label + date visibility when the toggle changes
    billActionClearedCheckbox.addEventListener("change", () => {
      const checked = billActionClearedCheckbox.checked;
      billActionClearedLabelEl.textContent = checked ? "Yes" : "No";
      if (appSettings.showCleared) {
        billActionClearedDateField.style.visibility = checked
          ? "visible"
          : "hidden";
        if (checked && !billActionClearedDateInput.value) {
          // Default cleared date to the current paid date, not today()
          billActionClearedDateInput.value = billActionDateInput.value || today();
        }
      }
    });
  }
  return billActionModal;
}

function openBillAction(row: BillRow): void {
  const bill = row.bill;
  billActionTitleEl.textContent = `Pay ${bill.name}`;

  // Item 8: always show the bill's read-only details
  billActionDetailsEl.innerHTML = "";
  const details: [string, string][] = [
    ["Type", bill.billType === "fixed" ? "Fixed" : "Variable"],
    ["Recurrence", describeRecurrence(bill.recurrence)],
    ["Autopay", bill.autopay ? "Yes" : "No"],
  ];
  if (bill.payMethod) details.push(["Pay Method", bill.payMethod]);
  if (bill.notes) details.push(["Notes", bill.notes]);
  for (const [label, value] of details) {
    const row = document.createElement("div");
    row.className = "budget-bill-action-detail";
    // `value` can carry user-entered text (Pay Method, Notes), escape it.
    row.innerHTML = `<span class="budget-bill-action-detail-label">${label}</span><span>${escapeHtml(value)}</span>`;
    billActionDetailsEl.appendChild(row);
  }

  if (row.kind === "paid") {
    const inst = row.instance!;
    activeBillAction = { mode: "edit", billId: bill.id, instanceId: inst.id };

    let subtitle = `Due ${formatDate(inst.dueDate)} · Paid ${formatDate(inst.paidDate)}`;
    if (inst.cleared)
      subtitle += ` · Cleared ${inst.clearedDate ? formatDate(inst.clearedDate) : ""}`;
    billActionSubtitleEl.textContent = subtitle;

    billActionAmountInput.value = String(inst.actualAmount);
    billActionDateInput.value = inst.paidDate;
    billActionClearedCheckbox.checked = inst.cleared;
    billActionClearedLabelEl.textContent = inst.cleared ? "Yes" : "No";
    // Item 7: hide the entire cleared row when the setting is off
    billActionClearedRowEl.style.display = appSettings.showCleared
      ? ""
      : "none";
    // Cleared date visibility within the row
    billActionClearedDateField.style.visibility =
      appSettings.showCleared && inst.cleared ? "visible" : "hidden";
    if (inst.cleared) billActionClearedDateInput.value = inst.clearedDate || "";
    billActionNotesInput.value = inst.notes;
    billActionNextDueField.style.display = "none";
    billActionSaveBtn.textContent = "Save Changes";
    billActionUndoBtn.style.display = "";
  } else {
    activeBillAction = { mode: "pay", billId: bill.id };

    billActionSubtitleEl.textContent = `Due ${formatDate(bill.nextDue)}`;
    billActionAmountInput.value =
      bill.amount === null ? "" : String(bill.amount);
    billActionDateInput.value = today();
    billActionClearedCheckbox.checked = false;
    billActionClearedLabelEl.textContent = "No";
    billActionClearedRowEl.style.display = appSettings.showCleared
      ? ""
      : "none";
    billActionClearedDateInput.value = ""; // clear stale value from previous bill
    billActionClearedDateField.style.visibility = "hidden";
    billActionNotesInput.value = "";
    billActionNextDueField.style.display = "";
    billActionNextDueInput.value = advanceDate(bill.nextDue, bill.recurrence);
    billActionSaveBtn.textContent = "Mark Paid";
    billActionUndoBtn.style.display = "none";
  }

  getBillActionModal().open();
}

function saveBillAction(): void {
  if (!activeBillAction) return;
  const bill = getBillById(activeBillAction.billId);
  if (!bill) return;

  const actualAmount = parseFloat(billActionAmountInput.value) || 0;
  const paidDate = billActionDateInput.value || today();
  const cleared = billActionClearedCheckbox.checked;
  const clearedDate = cleared
    ? billActionClearedDateInput.value || today()
    : "";
  const notes = billActionNotesInput.value.trim();

  if (activeBillAction.mode === "pay") {
    const dueDate = bill.nextDue;
    data.billInstances.push({
      id: makeId(),
      billId: bill.id,
      dueDate,
      plannedAmount: bill.amount,
      actualAmount,
      paidDate,
      cleared,
      clearedDate,
      notes,
    });
    bill.nextDue =
      billActionNextDueInput.value || advanceDate(dueDate, bill.recurrence);
    flash("Bill marked paid", "success");
  } else {
    if (activeBillAction.mode !== "edit") return;
    const { instanceId } = activeBillAction;
    const inst = data.billInstances.find((i) => i.id === instanceId);
    if (!inst) return;
    inst.actualAmount = actualAmount;
    inst.paidDate = paidDate;
    inst.cleared = cleared;
    inst.clearedDate = clearedDate;
    inst.notes = notes;
    flash("Payment updated", "success");
  }

  queueSave();
  renderBills();
  renderTotals();
  renderEntries();
  getBillActionModal().close();
}

/**
 * Removes the payment instance. If it's the most recent payment recorded for
 * this bill (no other instance has a later due date), the bill's nextDue is
 * restored to this instance's due date, i.e. it becomes pending again.
 * Otherwise nextDue is left as-is, since a later payment already moved it.
 */
function undoBillAction(): void {
  if (!activeBillAction || activeBillAction.mode !== "edit") return;
  const bill = getBillById(activeBillAction.billId);
  const { instanceId } = activeBillAction;
  const inst = data.billInstances.find((i) => i.id === instanceId);
  if (!bill || !inst) return;

  const isMostRecent = !data.billInstances.some(
    (i) => i.billId === bill.id && i.id !== inst.id && i.dueDate > inst.dueDate,
  );

  data.billInstances = data.billInstances.filter((i) => i.id !== inst.id);
  if (isMostRecent) bill.nextDue = inst.dueDate;

  queueSave();
  renderBills();
  renderTotals();
  renderEntries();
  getBillActionModal().close();
  flash("Payment undone", "success");
}

/* =============================================================================
   DATALISTS: quick-add source for category / source / expense-source fields
============================================================================= */

function fillDatalist(el: HTMLDataListElement, values: string[]): void {
  el.innerHTML = "";
  values
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      el.appendChild(opt);
    });
}

function refreshDatalists(): void {
  fillDatalist(
    sourceDatalist,
    getActiveIncomeSources().map((s) => s.name),
  );
  fillDatalist(
    categoryDatalist,
    getActiveCategories().map((c) => c.name),
  );
  fillDatalist(
    expenseSourceDatalist,
    getActiveExpenseSources().map((d) => d.name),
  );
}

/* =============================================================================
   ADD ENTRY
============================================================================= */

function setEntryType(type: "income" | "expense"): void {
  // Sync the date between panels before switching so the user stays on the
  // same date when toggling between income and expense entry.
  if (type === "expense" && incomeDateInput.value) {
    expenseDateInput.value = incomeDateInput.value;
  } else if (type === "income" && expenseDateInput.value) {
    incomeDateInput.value = expenseDateInput.value;
  }
  typeIncomeBtn.classList.toggle("active", type === "income");
  typeExpenseBtn.classList.toggle("active", type === "expense");
  incomeFieldsEl.style.display = type === "income" ? "" : "none";
  expenseFieldsEl.style.display = type === "expense" ? "" : "none";
}

function addIncomeEntry(): void {
  const date = incomeDateInput.value || today();
  const sourceName = incomeSourceInput.value.trim();
  if (!sourceName) {
    flash("Source is required", "error");
    return;
  }

  const expected = parseFloat(incomeExpectedInput.value) || 0;
  const actualRaw = incomeActualInput.value.trim();
  const actual = actualRaw === "" ? expected : parseFloat(actualRaw) || 0;
  const notes = incomeNotesInput.value.trim();
  const sourceId = findOrCreateIncomeSource(sourceName);

  data.incomeEntries.push({
    id: makeId(),
    date,
    sourceId,
    expected,
    actual,
    notes,
  });
  queueSave();

  incomeSourceInput.value = "";
  incomeExpectedInput.value = "";
  incomeActualInput.value = "";
  incomeNotesInput.value = "";
  actualTouched = false;

  refreshDatalists();
  renderTotals();
  renderEntries();
  incomeSourceInput.focus();
  flash("Income entry added", "success");
}

function addExpenseEntry(): void {
  const date = expenseDateInput.value || today();
  const categoryName = expenseCategoryInput.value.trim();
  if (!categoryName) {
    flash("Category is required", "error");
    return;
  }

  const amount = parseFloat(expenseAmountInput.value) || 0;
  const description = expenseSourceInput.value.trim();
  const notes = expenseNotesInput.value.trim();
  const categoryId = findOrCreateCategory(categoryName);
  if (description) findOrCreateExpenseSource(description);

  data.fluctuatingExpenses.push({
    id: makeId(),
    date,
    categoryId,
    description,
    amount,
    notes,
  });
  queueSave();

  expenseCategoryInput.value = "";
  expenseSourceInput.value = "";
  expenseAmountInput.value = "";
  expenseNotesInput.value = "";

  refreshDatalists();
  renderTotals();
  renderEntries();
  expenseCategoryInput.focus();
  flash("Expense entry added", "success");
}

/** Submits the Enter key inside any field of a container as a click on the given button. */
function bindEnterToSubmit(
  container: HTMLElement,
  btn: HTMLButtonElement,
): void {
  container.querySelectorAll("input").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        btn.click();
      }
    });
  });
}

/* =============================================================================
   SETUP MODAL: Categories / Income Sources / Expense Sources (simple lists)
   -----------------------------------------------------------------------------
   All three share the {id, name, status} shape and the same list UI: double-
   click a name to rename it, a status button to retire/reactivate. "Retired"
   items stay referenced by historical entries but drop out of active
   pickers/quick-add (getActiveX / findOrCreateX already enforce this).
============================================================================= */

type SimpleListKind = "categories" | "sources" | "expenseSources";
type SimpleEntity = { id: string; name: string; status: Status };

const SIMPLE_DELETE_KIND: Record<SimpleListKind, SetupDeleteKind> = {
  categories: "category",
  sources: "source",
  expenseSources: "expenseSource",
};

const SIMPLE_KIND_LABEL: Record<SimpleListKind, string> = {
  categories: "Category",
  sources: "Income source",
  expenseSources: "Expense source",
};

// Plural, lowercase (used in the "No ___ yet) add one above." empty-state
// message so it reads naturally for each tab (mirrors the Recurring Bills
// empty state at renderRecurringBillsList()).
const SIMPLE_EMPTY_LABEL: Record<SimpleListKind, string> = {
  sources: "income sources",
  categories: "expense categories",
  expenseSources: "expense sources",
};

function getSimpleList(kind: SimpleListKind): SimpleEntity[] {
  switch (kind) {
    case "categories":
      return data.categories;
    case "sources":
      return data.incomeSources;
    case "expenseSources":
      return data.expenseSources;
  }
}

function getSimpleListContainer(kind: SimpleListKind): HTMLElement {
  switch (kind) {
    case "categories":
      return categoriesListEl;
    case "sources":
      return sourcesListEl;
    case "expenseSources":
      return expenseSourcesListEl;
  }
}

/** Returns the "Expectation: $X / month" or "Threshold: $X / month" badge text
 *  for a setup list item, or null if no Expectation/Threshold is enabled. */
function buildBudgetBadgeText(kind: SimpleListKind, item: SimpleEntity): string | null {
  if (kind === "sources") {
    const s = item as IncomeSource;
    if (s.expectationEnabled && (s.expectation ?? 0) > 0) {
      return `Expectation: ${formatCurrency(s.expectation ?? 0)} / month`;
    }
  } else {
    const c = item as Category | ExpenseSource;
    if (c.thresholdEnabled && (c.threshold ?? 0) > 0) {
      return `Threshold: ${formatCurrency(c.threshold ?? 0)} / month`;
    }
  }
  return null;
}

function buildSimpleItemRow(
  kind: SimpleListKind,
  item: SimpleEntity,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "setup-item";
  if (item.status === "retired") row.classList.add("setup-item-retired");

  // Col 1: name (+ inline retired badge so it doesn't break column flow)
  const nameSpan = document.createElement("span");
  nameSpan.className = "setup-item-name";
  nameSpan.textContent = item.name;
  if (item.status === "retired") {
    const retiredBadge = document.createElement("span");
    retiredBadge.className = "setup-item-retired-badge";
    retiredBadge.textContent = "Retired";
    retiredBadge.style.marginLeft = "8px";
    nameSpan.appendChild(retiredBadge);
  }
  row.appendChild(nameSpan);

  // Col 2: budget badge, always rendered so bars left-align consistently;
  // empty when no expectation/threshold is set for this item. Budget-only
  // concept, so this class stays local to budget.css.
  const badge = document.createElement("span");
  badge.className = "budget-setup-item-budget-badge";
  const badgeText = buildBudgetBadgeText(kind, item);
  if (badgeText) badge.textContent = badgeText;
  row.appendChild(badge);

  const chevron = document.createElement("span");
  chevron.className = "setup-item-chevron";
  chevron.textContent = "›";
  row.appendChild(chevron);

  row.style.cursor = "pointer";
  row.addEventListener("click", () => {
    if (kind === "sources") openSourceEdit(item);
    else if (kind === "categories") openCategoryEdit(item);
    else openExpSourceEdit(item);
  });

  return row;
}

/* =============================================================================
   INCOME SOURCE MODALS: Add + Edit (fully independent)
============================================================================= */

let _sourceAddModal: Modal | null = null;
let _sourceEditModal: Modal | null = null;
let _sourceEditItem: SimpleEntity | null = null;

function getSourceAddModal(): Modal {
  if (!_sourceAddModal) {
    _sourceAddModal = new Modal(
      document.getElementById("budgetSourceAddBackdrop")!,
      { closeOnEsc: true, onOpen: () => setTimeout(() => nameInput.focus(), 50) },
    );
    const nameInput = document.getElementById("budgetSourceAddName") as HTMLInputElement;
    const expectToggle = document.getElementById("budgetSourceAddExpectToggle") as HTMLInputElement;
    const expectLabel = document.getElementById("budgetSourceAddExpectLabel")!;
    const expectField = document.getElementById("budgetSourceAddExpectField") as HTMLElement;
    const expectInput = document.getElementById("budgetSourceAddExpectation") as HTMLInputElement;

    function goBack() { _sourceAddModal!.close(); openSetupModalOnTab("sources"); }
    function doSave() {
      const name = nameInput.value.trim();
      if (!name) { flash("Name cannot be empty", "error"); return; }
      let expectAmt: number | null = null;
      if (expectToggle.checked) {
        expectAmt = parsePositiveDecimal(expectInput.value);
        if (expectAmt === null) {
          flash("Monthly Expectation must be a positive number", "error");
          return;
        }
      }
      addOrReactivateSimple("sources", name);
      // Apply Expectation to the item that was just created/reactivated
      const list = getSimpleList("sources");
      const created = list.find((i) => i.name.toLowerCase() === name.toLowerCase());
      if (created) {
        (created as IncomeSource).expectationEnabled = expectToggle.checked;
        (created as IncomeSource).expectation = expectToggle.checked ? expectAmt : null;
        queueSave();
        renderTotals();
      }
      _sourceAddModal!.close();
      openSetupModalOnTab("sources");
    }

    document.getElementById("budgetSourceAddBack")!.addEventListener("click", goBack);
    document.getElementById("budgetSourceAddClose")!.addEventListener("click", () => _sourceAddModal!.close());
    document.getElementById("budgetSourceAddCancel")!.addEventListener("click", goBack);
    document.getElementById("budgetSourceAddSave")!.addEventListener("click", doSave);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });
    expectToggle.addEventListener("change", () => {
      expectLabel.textContent = expectToggle.checked ? "Yes" : "No";
      expectField.style.maxHeight = expectToggle.checked ? "200px" : "0";
    });

  }
  return _sourceAddModal;
}

function openSourceAdd(): void {
  getSetupModal().close({ handoff: true });
  const nameInput = document.getElementById("budgetSourceAddName") as HTMLInputElement;
  const expectToggle = document.getElementById("budgetSourceAddExpectToggle") as HTMLInputElement;
  const expectLabel = document.getElementById("budgetSourceAddExpectLabel")!;
  const expectField = document.getElementById("budgetSourceAddExpectField") as HTMLElement;
  const expectInput = document.getElementById("budgetSourceAddExpectation") as HTMLInputElement;
  nameInput.value = "";
  expectToggle.checked = false;
  expectLabel.textContent = "No";
  expectField.style.maxHeight = "0";
  expectInput.value = "";
  getSourceAddModal().open();
}

function getSourceEditModal(): Modal {
  if (!_sourceEditModal) {
    _sourceEditModal = new Modal(
      document.getElementById("budgetSourceEditBackdrop")!,
      { closeOnEsc: true, onOpen: () => setTimeout(() => nameInput.focus(), 50), onClosed: () => { _sourceEditItem = null; } },
    );
    const nameInput   = document.getElementById("budgetSourceEditName") as HTMLInputElement;
    const expectToggle = document.getElementById("budgetSourceEditExpectToggle") as HTMLInputElement;
    const expectLabel  = document.getElementById("budgetSourceEditExpectLabel")!;
    const expectField  = document.getElementById("budgetSourceEditExpectField") as HTMLElement;
    const expectInput  = document.getElementById("budgetSourceEditExpectation") as HTMLInputElement;
    const retireBtn   = document.getElementById("budgetSourceEditRetire") as HTMLButtonElement;
    const deleteBtn   = document.getElementById("budgetSourceEditDelete") as HTMLButtonElement;

    function goBack() { _sourceEditModal!.close(); openSetupModalOnTab("sources"); }
    function doSave() {
      if (!_sourceEditItem) return;
      const name = nameInput.value.trim();
      if (!name) { flash("Name cannot be empty", "error"); return; }
      let expectAmt: number | null = null;
      if (expectToggle.checked) {
        expectAmt = parsePositiveDecimal(expectInput.value);
        if (expectAmt === null) {
          flash("Monthly Expectation must be a positive number", "error");
          return;
        }
      }
      _sourceEditItem.name = name;
      (_sourceEditItem as IncomeSource).expectationEnabled = expectToggle.checked;
      (_sourceEditItem as IncomeSource).expectation = expectToggle.checked ? expectAmt : null;
      queueSave(); refreshDatalists(); renderEntries();
      renderTotals();
      flash("Income source saved", "success");
      _sourceEditModal!.close(); openSetupModalOnTab("sources");
    }

    document.getElementById("budgetSourceEditBack")!.addEventListener("click", goBack);
    document.getElementById("budgetSourceEditClose")!.addEventListener("click", () => _sourceEditModal!.close());
    document.getElementById("budgetSourceEditCancel")!.addEventListener("click", goBack);
    document.getElementById("budgetSourceEditSave")!.addEventListener("click", doSave);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });
    expectToggle.addEventListener("change", () => {
      expectLabel.textContent = expectToggle.checked ? "Yes" : "No";
      expectField.style.maxHeight = expectToggle.checked ? "200px" : "0";
    });


    retireBtn.addEventListener("click", () => {
      if (!_sourceEditItem) return;
      _sourceEditItem.status = _sourceEditItem.status === "active" ? "retired" : "active";
      queueSave(); refreshDatalists();
      flash(_sourceEditItem.status === "retired" ? "Income source retired" : "Income source reactivated", "success");
      _sourceEditModal!.close(); openSetupModalOnTab("sources");
    });

    deleteBtn.addEventListener("click", () => {
      if (!_sourceEditItem) return;
      const item = _sourceEditItem;
      _sourceEditModal!.close();
      openSetupDelete("source", item.id, item.name,
        () => openSetupModalOnTab("sources"),
        () => openSetupModalOnTab("sources"),
      );
    });
  }
  return _sourceEditModal;
}

function openSourceEdit(item: SimpleEntity): void {
  _sourceEditItem = item;
  getSetupModal().close({ handoff: true });
  getSourceEditModal(); // ensure wired
  (document.getElementById("budgetSourceEditName") as HTMLInputElement).value = item.name;
  const expectToggle = document.getElementById("budgetSourceEditExpectToggle") as HTMLInputElement;
  const expectLabel  = document.getElementById("budgetSourceEditExpectLabel")!;
  const expectField  = document.getElementById("budgetSourceEditExpectField") as HTMLElement;
  const expectInput  = document.getElementById("budgetSourceEditExpectation") as HTMLInputElement;
  const expectEnabled = !!(item as IncomeSource).expectationEnabled;
  expectToggle.checked = expectEnabled;
  expectLabel.textContent = expectEnabled ? "Yes" : "No";
  expectField.style.maxHeight = expectEnabled ? "200px" : "0";
  expectInput.value = (item as IncomeSource).expectation != null ? String((item as IncomeSource).expectation) : "";
  const retireBtn = document.getElementById("budgetSourceEditRetire") as HTMLButtonElement;
  const deleteBtn = document.getElementById("budgetSourceEditDelete") as HTMLButtonElement;
  retireBtn.textContent = item.status === "active" ? "Retire" : "Reactivate";
  deleteBtn.style.display = item.status === "retired" ? "" : "none";
  getSourceEditModal().open();
}

/* =============================================================================
   EXPENSE CATEGORY MODALS: Add + Edit (fully independent)
============================================================================= */

let _categoryAddModal: Modal | null = null;
let _categoryEditModal: Modal | null = null;
let _categoryEditItem: SimpleEntity | null = null;

function getCategoryAddModal(): Modal {
  if (!_categoryAddModal) {
    _categoryAddModal = new Modal(
      document.getElementById("budgetCategoryAddBackdrop")!,
      { closeOnEsc: true, onOpen: () => setTimeout(() => nameInput.focus(), 50) },
    );
    const nameInput      = document.getElementById("budgetCategoryAddName") as HTMLInputElement;
    const excludeToggle  = document.getElementById("budgetCategoryAddExclude") as HTMLInputElement;
    const excludeLabel   = document.getElementById("budgetCategoryAddExcludeLabel")!;
    const threshToggle   = document.getElementById("budgetCategoryAddThreshToggle") as HTMLInputElement;
    const threshLabel    = document.getElementById("budgetCategoryAddThreshLabel")!;
    const threshField    = document.getElementById("budgetCategoryAddThreshField") as HTMLElement;
    const threshInput    = document.getElementById("budgetCategoryAddThreshold") as HTMLInputElement;
    const threshWarnInput = document.getElementById("budgetCategoryAddThreshWarn") as HTMLInputElement;

    function goBack() { _categoryAddModal!.close(); openSetupModalOnTab("categories"); }
    function doSave() {
      const name = nameInput.value.trim();
      if (!name) { flash("Name cannot be empty", "error"); return; }
      let threshAmt: number | null = null;
      let threshWarn: number | null = null;
      if (threshToggle.checked) {
        threshAmt = parsePositiveDecimal(threshInput.value);
        if (threshAmt === null) {
          flash("Monthly Threshold must be a positive number", "error");
          return;
        }
        threshWarn = parseWarningPct(threshWarnInput.value);
        if (threshWarn === null) {
          flash("Warning % must be a positive number between 0 and 100", "error");
          return;
        }
      }
      addOrReactivateSimple("categories", name);
      // Apply excludeFromCharts / Threshold to the item that was just created/reactivated
      const list = getSimpleList("categories");
      const created = list.find((i) => i.name.toLowerCase() === name.toLowerCase());
      if (created) {
        (created as Category).excludeFromCharts = excludeToggle.checked;
        (created as Category).thresholdEnabled = threshToggle.checked;
        (created as Category).threshold = threshToggle.checked ? threshAmt : null;
        (created as Category).thresholdWarningPct = threshToggle.checked ? threshWarn : 80;
        queueSave();
        renderTotals();
      }
      _categoryAddModal!.close();
      openSetupModalOnTab("categories");
    }

    document.getElementById("budgetCategoryAddBack")!.addEventListener("click", goBack);
    document.getElementById("budgetCategoryAddClose")!.addEventListener("click", () => _categoryAddModal!.close());
    document.getElementById("budgetCategoryAddCancel")!.addEventListener("click", goBack);
    document.getElementById("budgetCategoryAddSave")!.addEventListener("click", doSave);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });
    excludeToggle.addEventListener("change", () => { excludeLabel.textContent = excludeToggle.checked ? "Yes" : "No"; });
    threshToggle.addEventListener("change", () => {
      threshLabel.textContent = threshToggle.checked ? "Yes" : "No";
      threshField.style.maxHeight = threshToggle.checked ? "200px" : "0";
    });
  }
  return _categoryAddModal;
}

function openCategoryAdd(): void {
  getSetupModal().close({ handoff: true });
  const nameInput     = document.getElementById("budgetCategoryAddName") as HTMLInputElement;
  const excludeToggle = document.getElementById("budgetCategoryAddExclude") as HTMLInputElement;
  const excludeLabel  = document.getElementById("budgetCategoryAddExcludeLabel")!;
  const threshToggle  = document.getElementById("budgetCategoryAddThreshToggle") as HTMLInputElement;
  const threshLabel   = document.getElementById("budgetCategoryAddThreshLabel")!;
  const threshField   = document.getElementById("budgetCategoryAddThreshField") as HTMLElement;
  const threshInput   = document.getElementById("budgetCategoryAddThreshold") as HTMLInputElement;
  const threshWarnInput = document.getElementById("budgetCategoryAddThreshWarn") as HTMLInputElement;
  nameInput.value = "";
  excludeToggle.checked = false;
  excludeLabel.textContent = "No";
  threshToggle.checked = false;
  threshLabel.textContent = "No";
  threshField.style.maxHeight = "0";
  threshInput.value = "";
  threshWarnInput.value = "80";
  getCategoryAddModal().open();
}

function getCategoryEditModal(): Modal {
  if (!_categoryEditModal) {
    _categoryEditModal = new Modal(
      document.getElementById("budgetCategoryEditBackdrop")!,
      { closeOnEsc: true, onOpen: () => setTimeout(() => nameInput.focus(), 50), onClosed: () => { _categoryEditItem = null; } },
    );
    const nameInput      = document.getElementById("budgetCategoryEditName") as HTMLInputElement;
    const excludeToggle  = document.getElementById("budgetCategoryEditExclude") as HTMLInputElement;
    const excludeLabel   = document.getElementById("budgetCategoryEditExcludeLabel")!;
    const threshToggle   = document.getElementById("budgetCategoryEditThreshToggle") as HTMLInputElement;
    const threshLabel    = document.getElementById("budgetCategoryEditThreshLabel")!;
    const threshField    = document.getElementById("budgetCategoryEditThreshField") as HTMLElement;
    const threshInput    = document.getElementById("budgetCategoryEditThreshold") as HTMLInputElement;
    const threshWarnInput = document.getElementById("budgetCategoryEditThreshWarn") as HTMLInputElement;
    const retireBtn      = document.getElementById("budgetCategoryEditRetire") as HTMLButtonElement;
    const deleteBtn      = document.getElementById("budgetCategoryEditDelete") as HTMLButtonElement;

    function goBack() { _categoryEditModal!.close(); openSetupModalOnTab("categories"); }
    function doSave() {
      if (!_categoryEditItem) return;
      const name = nameInput.value.trim();
      if (!name) { flash("Name cannot be empty", "error"); return; }
      let threshAmt: number | null = null;
      let threshWarn: number | null = null;
      if (threshToggle.checked) {
        threshAmt = parsePositiveDecimal(threshInput.value);
        if (threshAmt === null) {
          flash("Monthly Threshold must be a positive number", "error");
          return;
        }
        threshWarn = parseWarningPct(threshWarnInput.value);
        if (threshWarn === null) {
          flash("Warning % must be a positive number between 0 and 100", "error");
          return;
        }
      }
      _categoryEditItem.name = name;
      (_categoryEditItem as Category).excludeFromCharts = excludeToggle.checked;
      (_categoryEditItem as Category).thresholdEnabled = threshToggle.checked;
      (_categoryEditItem as Category).threshold = threshToggle.checked ? threshAmt : null;
      (_categoryEditItem as Category).thresholdWarningPct = threshToggle.checked ? threshWarn : 80;
      queueSave(); refreshDatalists(); renderEntries();
      renderTotals();
      flash("Expense category saved", "success");
      _categoryEditModal!.close(); openSetupModalOnTab("categories");
    }

    document.getElementById("budgetCategoryEditBack")!.addEventListener("click", goBack);
    document.getElementById("budgetCategoryEditClose")!.addEventListener("click", () => _categoryEditModal!.close());
    document.getElementById("budgetCategoryEditCancel")!.addEventListener("click", goBack);
    document.getElementById("budgetCategoryEditSave")!.addEventListener("click", doSave);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });

    excludeToggle.addEventListener("change", () => { excludeLabel.textContent = excludeToggle.checked ? "Yes" : "No"; });
    threshToggle.addEventListener("change", () => {
      threshLabel.textContent = threshToggle.checked ? "Yes" : "No";
      threshField.style.maxHeight = threshToggle.checked ? "200px" : "0";
    });

    retireBtn.addEventListener("click", () => {
      if (!_categoryEditItem) return;
      _categoryEditItem.status = _categoryEditItem.status === "active" ? "retired" : "active";
      queueSave(); refreshDatalists();
      flash(_categoryEditItem.status === "retired" ? "Category retired" : "Category reactivated", "success");
      _categoryEditModal!.close(); openSetupModalOnTab("categories");
    });

    deleteBtn.addEventListener("click", () => {
      if (!_categoryEditItem) return;
      const item = _categoryEditItem;
      _categoryEditModal!.close();
      openSetupDelete("category", item.id, item.name,
        () => openSetupModalOnTab("categories"),
        () => openSetupModalOnTab("categories"),
      );
    });
  }
  return _categoryEditModal;
}

function openCategoryEdit(item: SimpleEntity): void {
  _categoryEditItem = item;
  getSetupModal().close({ handoff: true });
  getCategoryEditModal(); // ensure wired
  (document.getElementById("budgetCategoryEditName") as HTMLInputElement).value = item.name;
  const excludeToggle = document.getElementById("budgetCategoryEditExclude") as HTMLInputElement;
  const excludeLabel  = document.getElementById("budgetCategoryEditExcludeLabel")!;
  const excluded = !!(item as Category).excludeFromCharts;
  excludeToggle.checked = excluded;
  excludeLabel.textContent = excluded ? "Yes" : "No";
  const threshToggle = document.getElementById("budgetCategoryEditThreshToggle") as HTMLInputElement;
  const threshLabel  = document.getElementById("budgetCategoryEditThreshLabel")!;
  const threshField  = document.getElementById("budgetCategoryEditThreshField") as HTMLElement;
  const threshInput  = document.getElementById("budgetCategoryEditThreshold") as HTMLInputElement;
  const threshWarnInput = document.getElementById("budgetCategoryEditThreshWarn") as HTMLInputElement;
  const threshEnabled = !!(item as Category).thresholdEnabled;
  threshToggle.checked = threshEnabled;
  threshLabel.textContent = threshEnabled ? "Yes" : "No";
  threshField.style.maxHeight = threshEnabled ? "200px" : "0";
  threshInput.value = (item as Category).threshold != null ? String((item as Category).threshold) : "";
  threshWarnInput.value = String((item as Category).thresholdWarningPct ?? 80);
  const retireBtn = document.getElementById("budgetCategoryEditRetire") as HTMLButtonElement;
  const deleteBtn = document.getElementById("budgetCategoryEditDelete") as HTMLButtonElement;
  retireBtn.textContent = item.status === "active" ? "Retire" : "Reactivate";
  deleteBtn.style.display = item.status === "retired" ? "" : "none";
  getCategoryEditModal().open();
}

/* =============================================================================
   EXPENSE SOURCE MODALS: Add + Edit (fully independent)
============================================================================= */

let _expSourceAddModal: Modal | null = null;
let _expSourceEditModal: Modal | null = null;
let _expSourceEditItem: SimpleEntity | null = null;

function getExpSourceAddModal(): Modal {
  if (!_expSourceAddModal) {
    _expSourceAddModal = new Modal(
      document.getElementById("budgetExpSourceAddBackdrop")!,
      { closeOnEsc: true, onOpen: () => setTimeout(() => nameInput.focus(), 50) },
    );
    const nameInput      = document.getElementById("budgetExpSourceAddName") as HTMLInputElement;
    const excludeToggle  = document.getElementById("budgetExpSourceAddExclude") as HTMLInputElement;
    const excludeLabel   = document.getElementById("budgetExpSourceAddExcludeLabel")!;
    const threshToggle   = document.getElementById("budgetExpSourceAddThreshToggle") as HTMLInputElement;
    const threshLabel    = document.getElementById("budgetExpSourceAddThreshLabel")!;
    const threshField    = document.getElementById("budgetExpSourceAddThreshField") as HTMLElement;
    const threshInput    = document.getElementById("budgetExpSourceAddThreshold") as HTMLInputElement;
    const threshWarnInput = document.getElementById("budgetExpSourceAddThreshWarn") as HTMLInputElement;

    function goBack() { _expSourceAddModal!.close(); openSetupModalOnTab("expenseSources"); }
    function doSave() {
      const name = nameInput.value.trim();
      if (!name) { flash("Name cannot be empty", "error"); return; }
      let threshAmt: number | null = null;
      let threshWarn: number | null = null;
      if (threshToggle.checked) {
        threshAmt = parsePositiveDecimal(threshInput.value);
        if (threshAmt === null) {
          flash("Monthly Threshold must be a positive number", "error");
          return;
        }
        threshWarn = parseWarningPct(threshWarnInput.value);
        if (threshWarn === null) {
          flash("Warning % must be a positive number between 0 and 100", "error");
          return;
        }
      }
      addOrReactivateSimple("expenseSources", name);
      // Apply excludeFromCharts to the item that was just created/reactivated
      const list = getSimpleList("expenseSources");
      const created = list.find((i) => i.name.toLowerCase() === name.toLowerCase());
      if (created) {
        (created as ExpenseSource).excludeFromCharts = excludeToggle.checked;
        (created as ExpenseSource).thresholdEnabled = threshToggle.checked;
        (created as ExpenseSource).threshold = threshToggle.checked ? threshAmt : null;
        (created as ExpenseSource).thresholdWarningPct = threshToggle.checked ? threshWarn : 80;
        queueSave();
        renderTotals();
      }
      _expSourceAddModal!.close();
      openSetupModalOnTab("expenseSources");
    }

    document.getElementById("budgetExpSourceAddBack")!.addEventListener("click", goBack);
    document.getElementById("budgetExpSourceAddClose")!.addEventListener("click", () => _expSourceAddModal!.close());
    document.getElementById("budgetExpSourceAddCancel")!.addEventListener("click", goBack);
    document.getElementById("budgetExpSourceAddSave")!.addEventListener("click", doSave);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });
    excludeToggle.addEventListener("change", () => { excludeLabel.textContent = excludeToggle.checked ? "Yes" : "No"; });
    threshToggle.addEventListener("change", () => {
      threshLabel.textContent = threshToggle.checked ? "Yes" : "No";
      threshField.style.maxHeight = threshToggle.checked ? "200px" : "0";
    });
  }
  return _expSourceAddModal;
}

function openExpSourceAdd(): void {
  getSetupModal().close({ handoff: true });
  const nameInput     = document.getElementById("budgetExpSourceAddName") as HTMLInputElement;
  const excludeToggle = document.getElementById("budgetExpSourceAddExclude") as HTMLInputElement;
  const excludeLabel  = document.getElementById("budgetExpSourceAddExcludeLabel")!;
  const threshToggle  = document.getElementById("budgetExpSourceAddThreshToggle") as HTMLInputElement;
  const threshLabel   = document.getElementById("budgetExpSourceAddThreshLabel")!;
  const threshField   = document.getElementById("budgetExpSourceAddThreshField") as HTMLElement;
  const threshInput   = document.getElementById("budgetExpSourceAddThreshold") as HTMLInputElement;
  const threshWarnInput = document.getElementById("budgetExpSourceAddThreshWarn") as HTMLInputElement;
  nameInput.value = "";
  excludeToggle.checked = false;
  excludeLabel.textContent = "No";
  threshToggle.checked = false;
  threshLabel.textContent = "No";
  threshField.style.maxHeight = "0";
  threshInput.value = "";
  threshWarnInput.value = "80";
  getExpSourceAddModal().open();
}

function getExpSourceEditModal(): Modal {
  if (!_expSourceEditModal) {
    _expSourceEditModal = new Modal(
      document.getElementById("budgetExpSourceEditBackdrop")!,
      { closeOnEsc: true, onOpen: () => setTimeout(() => nameInput.focus(), 50), onClosed: () => { _expSourceEditItem = null; } },
    );
    const nameInput      = document.getElementById("budgetExpSourceEditName") as HTMLInputElement;
    const excludeToggle  = document.getElementById("budgetExpSourceEditExclude") as HTMLInputElement;
    const excludeLabel   = document.getElementById("budgetExpSourceEditExcludeLabel")!;
    const threshToggle   = document.getElementById("budgetExpSourceEditThreshToggle") as HTMLInputElement;
    const threshLabel    = document.getElementById("budgetExpSourceEditThreshLabel")!;
    const threshField    = document.getElementById("budgetExpSourceEditThreshField") as HTMLElement;
    const threshInput    = document.getElementById("budgetExpSourceEditThreshold") as HTMLInputElement;
    const threshWarnInput = document.getElementById("budgetExpSourceEditThreshWarn") as HTMLInputElement;
    const retireBtn      = document.getElementById("budgetExpSourceEditRetire") as HTMLButtonElement;
    const deleteBtn      = document.getElementById("budgetExpSourceEditDelete") as HTMLButtonElement;

    function goBack() { _expSourceEditModal!.close(); openSetupModalOnTab("expenseSources"); }
    function doSave() {
      if (!_expSourceEditItem) return;
      const name = nameInput.value.trim();
      if (!name) { flash("Name cannot be empty", "error"); return; }
      let threshAmt: number | null = null;
      let threshWarn: number | null = null;
      if (threshToggle.checked) {
        threshAmt = parsePositiveDecimal(threshInput.value);
        if (threshAmt === null) {
          flash("Monthly Threshold must be a positive number", "error");
          return;
        }
        threshWarn = parseWarningPct(threshWarnInput.value);
        if (threshWarn === null) {
          flash("Warning % must be a positive number between 0 and 100", "error");
          return;
        }
      }
      _expSourceEditItem.name = name;
      (_expSourceEditItem as ExpenseSource).excludeFromCharts = excludeToggle.checked;
      (_expSourceEditItem as ExpenseSource).thresholdEnabled = threshToggle.checked;
      (_expSourceEditItem as ExpenseSource).threshold = threshToggle.checked ? threshAmt : null;
      (_expSourceEditItem as ExpenseSource).thresholdWarningPct = threshToggle.checked ? threshWarn : 80;
      queueSave(); refreshDatalists(); renderEntries();
      renderTotals();
      flash("Expense source saved", "success");
      _expSourceEditModal!.close(); openSetupModalOnTab("expenseSources");
    }

    document.getElementById("budgetExpSourceEditBack")!.addEventListener("click", goBack);
    document.getElementById("budgetExpSourceEditClose")!.addEventListener("click", () => _expSourceEditModal!.close());
    document.getElementById("budgetExpSourceEditCancel")!.addEventListener("click", goBack);
    document.getElementById("budgetExpSourceEditSave")!.addEventListener("click", doSave);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });

    excludeToggle.addEventListener("change", () => { excludeLabel.textContent = excludeToggle.checked ? "Yes" : "No"; });
    threshToggle.addEventListener("change", () => {
      threshLabel.textContent = threshToggle.checked ? "Yes" : "No";
      threshField.style.maxHeight = threshToggle.checked ? "200px" : "0";
    });

    retireBtn.addEventListener("click", () => {
      if (!_expSourceEditItem) return;
      _expSourceEditItem.status = _expSourceEditItem.status === "active" ? "retired" : "active";
      queueSave(); refreshDatalists();
      flash(_expSourceEditItem.status === "retired" ? "Expense source retired" : "Expense source reactivated", "success");
      _expSourceEditModal!.close(); openSetupModalOnTab("expenseSources");
    });

    deleteBtn.addEventListener("click", () => {
      if (!_expSourceEditItem) return;
      const item = _expSourceEditItem;
      _expSourceEditModal!.close();
      openSetupDelete("expenseSource", item.id, item.name,
        () => openSetupModalOnTab("expenseSources"),
        () => openSetupModalOnTab("expenseSources"),
      );
    });
  }
  return _expSourceEditModal;
}

function openExpSourceEdit(item: SimpleEntity): void {
  _expSourceEditItem = item;
  getSetupModal().close({ handoff: true });
  getExpSourceEditModal(); // ensure wired
  (document.getElementById("budgetExpSourceEditName") as HTMLInputElement).value = item.name;
  const excludeToggle = document.getElementById("budgetExpSourceEditExclude") as HTMLInputElement;
  const excludeLabel  = document.getElementById("budgetExpSourceEditExcludeLabel")!;
  const excluded = !!(item as ExpenseSource).excludeFromCharts;
  excludeToggle.checked = excluded;
  excludeLabel.textContent = excluded ? "Yes" : "No";
  const threshToggle = document.getElementById("budgetExpSourceEditThreshToggle") as HTMLInputElement;
  const threshLabel  = document.getElementById("budgetExpSourceEditThreshLabel")!;
  const threshField  = document.getElementById("budgetExpSourceEditThreshField") as HTMLElement;
  const threshInput  = document.getElementById("budgetExpSourceEditThreshold") as HTMLInputElement;
  const threshWarnInput = document.getElementById("budgetExpSourceEditThreshWarn") as HTMLInputElement;
  const threshEnabled = !!(item as ExpenseSource).thresholdEnabled;
  threshToggle.checked = threshEnabled;
  threshLabel.textContent = threshEnabled ? "Yes" : "No";
  threshField.style.maxHeight = threshEnabled ? "200px" : "0";
  threshInput.value = (item as ExpenseSource).threshold != null ? String((item as ExpenseSource).threshold) : "";
  threshWarnInput.value = String((item as ExpenseSource).thresholdWarningPct ?? 80);
  const retireBtn = document.getElementById("budgetExpSourceEditRetire") as HTMLButtonElement;
  const deleteBtn = document.getElementById("budgetExpSourceEditDelete") as HTMLButtonElement;
  retireBtn.textContent = item.status === "active" ? "Retire" : "Reactivate";
  deleteBtn.style.display = item.status === "retired" ? "" : "none";
  getExpSourceEditModal().open();
}

function renderSimpleList(kind: SimpleListKind): void {
  const container = getSimpleListContainer(kind);
  const list = getSimpleList(kind);
  container.innerHTML = "";

  if (list.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder-text";
    p.textContent = `No ${SIMPLE_EMPTY_LABEL[kind]} yet. Add one above.`;
    container.appendChild(p);
    return;
  }

  [...list]
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "active" ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .forEach((item) => container.appendChild(buildSimpleItemRow(kind, item)));
}

const SIMPLE_ADD_LABEL: Record<SimpleListKind, string> = {
  sources: "Income Source",
  categories: "Expense Category",
  expenseSources: "Expense Source",
};

/**
 * Adds a new active entry, or reactivates an existing one (active or retired)
 * with a case-insensitive matching name. Used by the Setup modal's "Add"
 * buttons, an explicit add action, so reactivating a matching retired item
 * makes more sense here than the silent-duplicate behaviour of findOrCreateX
 * (which only matches active items, for in-form quick-add).
 */
function addOrReactivateSimple(kind: SimpleListKind, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;

  const list = getSimpleList(kind);
  const existing = list.find(
    (item) => item.name.toLowerCase() === trimmed.toLowerCase(),
  );
  const wasReactivated = !!existing && existing.status === "retired";
  if (existing) {
    existing.status = "active";
  } else {
    list.push({ id: makeId(), name: trimmed, status: "active" });
  }

  const label = SIMPLE_ADD_LABEL[kind];
  flash(wasReactivated ? `${label} reactivated` : `${label} added`, "success");

  queueSave();
  refreshDatalists();
  renderSimpleList(kind);
}

/* =============================================================================
   BILL EDITOR MODAL: Add/Edit Recurring Bill
   -----------------------------------------------------------------------------
   Its own modal (not an inline accordion), opening it closes the Setup
   modal and vice versa, following the same "replace, don't stack" pattern
   used elsewhere (e.g. README/Licensing <-> Full License). The back-arrow
   and Cancel return to Setup; the X dismisses entirely without reopening it
   (matches the established convention, only Escape/X are "no return").
============================================================================= */

let editingBillId: string | "new" | null = null;
let billEditModal: Modal | null = null;

/** Labeled field wrapper for the setup forms. Pass "" to omit the <label>. */
function makeSetupField(label: string): HTMLElement {
  const field = document.createElement("div");
  field.className = "budget-setup-field";
  if (label) {
    const labelEl = document.createElement("label");
    labelEl.textContent = label;
    field.appendChild(labelEl);
  }
  return field;
}

function getBillEditModal(): Modal {
  if (!billEditModal) {
    billEditModal = new Modal(
      document.getElementById("budgetBillEditBackdrop")!,
      {
        closeOnEsc: true,
        onClosed: () => {
          editingBillId = null;
        },
      },
    );
    billSaveBtn.addEventListener("click", saveBillEdit);
    billRetireBtn.addEventListener("click", toggleBillEditStatus);
    billDeleteBtn.addEventListener("click", deleteBillEdit);
    billCancelBtn.addEventListener("click", returnToSetupFromBillEdit);
    billBackBtn.addEventListener("click", returnToSetupFromBillEdit);
    billCloseBtn.addEventListener("click", () => billEditModal!.close());
    // Item 7: update autopay label on toggle change
    billAutopayCheckbox.addEventListener("change", () => {
      billAutopayLabelEl.textContent = billAutopayCheckbox.checked
        ? "Yes"
        : "No";
    });
  }
  return billEditModal;
}

function returnToSetupFromBillEdit(): void {
  getBillEditModal().close();
  // Names the tab, like every other editor's back path. The handoff close in
  // openBillEditor() would restore it anyway, but stating it keeps this from
  // depending on that at a distance.
  openSetupModalOnTab("bills");
}

/** Opens the Bill Editor for `bill`, or blank fields if `bill` is null (new). */
function openBillEditor(bill: RecurringBill | null): void {
  editingBillId = bill ? bill.id : "new";
  billEditTitleEl.textContent = bill
    ? "Edit Recurring Bill"
    : "Add Recurring Bill";

  billNameInput.value = bill?.name ?? "";
  billTypeSelect.value = bill?.billType ?? "fixed";
  billAmountInput.value =
    bill && bill.amount !== null ? String(bill.amount) : "";
  billIntervalInput.value = String(bill?.recurrence.interval ?? 1);
  billUnitSelect.value = bill?.recurrence.unit ?? "months";
  billNextDueInput.value = bill?.nextDue ?? today();
  billPayMethodInput.value = bill?.payMethod ?? "";
  billAutopayCheckbox.checked = bill?.autopay ?? false;
  billAutopayLabelEl.textContent = billAutopayCheckbox.checked ? "Yes" : "No";
  billNotesInput.value = bill?.notes ?? "";

  if (bill) {
    billRetireBtn.style.display = "";
    billRetireBtn.textContent =
      bill.status === "active" ? "Retire" : "Reactivate";
    billDeleteBtn.style.display = bill.status === "retired" ? "" : "none";
    billSaveBtn.textContent = "Save";
  } else {
    billRetireBtn.style.display = "none";
    billDeleteBtn.style.display = "none";
    billSaveBtn.textContent = "Add";
  }

  getSetupModal().close({ handoff: true });
  getBillEditModal().open();
}

function saveBillEdit(): void {
  const name = billNameInput.value.trim();
  if (!name) {
    flash("Bill name is required", "error");
    return;
  }

  const billType = billTypeSelect.value as BillType;
  const amountRaw = billAmountInput.value.trim();
  const amount = amountRaw === "" ? null : parseFloat(amountRaw) || 0;
  const interval = Math.max(1, parseInt(billIntervalInput.value, 10) || 1);
  const unit = billUnitSelect.value as RecurrenceUnit;
  const nextDue = billNextDueInput.value || today();
  const payMethod = billPayMethodInput.value.trim();
  const autopay = billAutopayCheckbox.checked;
  const notes = billNotesInput.value.trim();

  if (editingBillId && editingBillId !== "new") {
    const bill = getBillById(editingBillId);
    if (!bill) return;
    bill.name = name;
    bill.billType = billType;
    bill.amount = amount;
    bill.recurrence = { interval, unit };
    bill.nextDue = nextDue;
    bill.payMethod = payMethod;
    bill.autopay = autopay;
    bill.notes = notes;
  } else {
    data.recurringBills.push({
      id: makeId(),
      name,
      billType,
      amount,
      recurrence: { interval, unit },
      nextDue,
      autopay,
      payMethod,
      status: "active",
      notes,
    });
  }

  queueSave();
  renderBills();
  renderTotals();
  renderEntries();
  flash("Recurring bill saved", "success");
  returnToSetupFromBillEdit();
}

function toggleBillEditStatus(): void {
  if (!editingBillId || editingBillId === "new") return;
  const bill = getBillById(editingBillId);
  if (!bill) return;

  bill.status = bill.status === "active" ? "retired" : "active";
  billRetireBtn.textContent =
    bill.status === "active" ? "Retire" : "Reactivate";
  billDeleteBtn.style.display = bill.status === "retired" ? "" : "none";

  queueSave();
  renderBills();
  renderTotals();
  renderEntries();
  flash(
    bill.status === "retired" ? "Bill retired" : "Bill reactivated",
    "success",
  );
}

/** Only reachable once a bill is retired. Hands off to the shared delete-confirm modal. */
function deleteBillEdit(): void {
  if (!editingBillId || editingBillId === "new") return;
  const bill = getBillById(editingBillId);
  if (!bill) return;

  getBillEditModal().close();
  openSetupDelete(
    "bill",
    bill.id,
    bill.name,
    () => openBillEditor(bill), // cancel -> back to this bill's editor
    () => openSetupModalOnTab("bills"), // confirm -> back to Setup's bill list
  );
}

/* =============================================================================
   SETUP MODAL: Recurring Bills list
============================================================================= */

/** One bill's row in the Setup modal's Recurring Bills list, clicking it opens the Bill Editor. */
function buildBillItemCard(bill: RecurringBill): HTMLElement {
  const card = document.createElement("div");
  card.className = "budget-setup-bill-item";
  if (bill.status === "retired")
    card.classList.add("budget-setup-item-retired");
  card.addEventListener("click", () => openBillEditor(bill));

  const summary = document.createElement("div");
  summary.className = "budget-setup-bill-summary";

  const name = document.createElement("span");
  name.className = "budget-setup-bill-summary-name";
  name.textContent = bill.name;
  summary.appendChild(name);

  const meta = document.createElement("span");
  meta.className = "budget-setup-bill-summary-meta";
  meta.textContent = `${describeRecurrence(bill.recurrence)} · Next ${formatDate(bill.nextDue)}`;
  summary.appendChild(meta);

  const amount = document.createElement("span");
  amount.className = "budget-setup-bill-summary-amount";
  amount.textContent = formatBillAmount(bill);
  summary.appendChild(amount);

  card.appendChild(summary);
  return card;
}

function renderBillsList(): void {
  billsListEl.innerHTML = "";

  const sorted = [...data.recurringBills].sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  if (sorted.length === 0) {
    const p = document.createElement("p");
    p.className = "placeholder-text";
    p.textContent = "No recurring bills yet. Add one above.";
    billsListEl.appendChild(p);
    return;
  }

  for (const bill of sorted) {
    billsListEl.appendChild(buildBillItemCard(bill));
  }
}

function startNewBill(): void {
  openBillEditor(null);
}

/* =============================================================================
   SETUP MODAL: DELETE CONFIRM (shared across all four tabs + Bill Editor)
   -----------------------------------------------------------------------------
   Only reachable for already-retired items (the delete icon is hidden until
   then), but permanent deletion still gets its own confirmation. Deleting a
   recurring bill also removes its payment history (billInstances) so nothing
   is left pointing at a bill that no longer exists.

   Follows the "replace, don't stack" pattern: the caller closes its own modal
   before calling openSetupDelete, which opens this one in its place. Cancel
   and Confirm each close this modal and run a captured "return to" callback.
   Cancel goes back to where the request came from, Confirm goes back to the
   relevant Setup list. Escape/X are full dismissals with no return, matching
   the convention used by the README/Licensing modals.
============================================================================= */

type SetupDeleteKind = "category" | "source" | "expenseSource" | "bill";

let pendingSetupDelete: { kind: SetupDeleteKind; id: string } | null = null;
let setupDeleteModal: Modal | null = null;
let setupDeleteCancelReturn: (() => void) | null = null;
let setupDeleteConfirmReturn: (() => void) | null = null;

function getSetupDeleteModal(): Modal {
  if (!setupDeleteModal) {
    setupDeleteModal = new Modal(
      document.getElementById("budgetSetupDeleteBackdrop")!,
      {
        closeOnEsc: true,
        onClosed: () => {
          pendingSetupDelete = null;
          setupDeleteCancelReturn = null;
          setupDeleteConfirmReturn = null;
        },
      },
    );
    document
      .getElementById("budgetSetupDeleteConfirmBtn")!
      .addEventListener("click", confirmSetupDelete);
    document
      .getElementById("budgetSetupDeleteCancelBtn")!
      .addEventListener("click", () => {
        const ret = setupDeleteCancelReturn;
        setupDeleteCancelReturn = null;
        setupDeleteConfirmReturn = null;
        setupDeleteModal!.close();
        ret?.();
      });
  }
  return setupDeleteModal;
}

/** The caller must close its own modal before calling this. */
function openSetupDelete(
  kind: SetupDeleteKind,
  id: string,
  name: string,
  cancelReturn: () => void,
  confirmReturn: () => void,
): void {
  pendingSetupDelete = { kind, id };
  setupDeleteCancelReturn = cancelReturn;
  setupDeleteConfirmReturn = confirmReturn;

  const messageEl = document.getElementById("budgetSetupDeleteMessage")!;
  if (kind === "bill") {
    messageEl.textContent =
      `Permanently delete "${name}"? Its payment history will be removed too, ` +
      `and past totals that included it will change. This can't be undone.`;
  } else {
    // Count how many ledger entries reference this item
    let impactCount = 0;
    if (kind === "source") {
      impactCount = data.incomeEntries.filter((e) => e.sourceId === id).length;
    } else if (kind === "category") {
      impactCount = data.fluctuatingExpenses.filter((e) => e.categoryId === id).length;
    } else if (kind === "expenseSource") {
      impactCount = data.fluctuatingExpenses.filter((e) => e.description === name).length;
    }
    const impactNote = impactCount > 0
      ? ` It is referenced by ${impactCount} ledger ${impactCount === 1 ? "item" : "items"}.`
      : "";
    messageEl.textContent = `Permanently delete "${name}"?${impactNote} This can't be undone.`;
  }

  getSetupDeleteModal().open();
}

function confirmSetupDelete(): void {
  if (!pendingSetupDelete) return;
  const { kind, id } = pendingSetupDelete;

  switch (kind) {
    case "category":
      data.categories = data.categories.filter((c) => c.id !== id);
      renderSimpleList("categories");
      break;
    case "source":
      data.incomeSources = data.incomeSources.filter((s) => s.id !== id);
      renderSimpleList("sources");
      break;
    case "expenseSource":
      data.expenseSources = data.expenseSources.filter((d) => d.id !== id);
      renderSimpleList("expenseSources");
      break;
    case "bill":
      data.recurringBills = data.recurringBills.filter((b) => b.id !== id);
      data.billInstances = data.billInstances.filter(
        (inst) => inst.billId !== id,
      );
      renderBillsList();
      renderBills();
      break;
  }

  queueSave();
  refreshDatalists();
  renderEntries();
  renderTotals();

  const ret = setupDeleteConfirmReturn;
  setupDeleteCancelReturn = null;
  setupDeleteConfirmReturn = null;
  getSetupDeleteModal().close();
  ret?.();

  const DELETE_LABELS: Record<SetupDeleteKind, string> = {
    category: "Expense Category",
    source: "Income Source",
    expenseSource: "Expense Source",
    bill: "Recurring Bill",
  };
  flash(`${DELETE_LABELS[kind]} deleted`, "success");
}

/* =============================================================================
   SETUP MODAL: chrome (tabs + open/close)
============================================================================= */

const SETUP_TABS = [
  "sources",
  "bills",
  "categories",
  "expenseSources",
  "preferences",
] as const;
type SetupTab = (typeof SETUP_TABS)[number];

/** Setup's tab strip, on the shared ModalTabs controller (modal.ts). It owns
 *  tab state, pane visibility and pane scroll resets. */
const setupTabs = new ModalTabs<SetupTab>({
  scope: "#budgetSetupModal",
  key: "budgetTab",
  panes: {
    sources:        "budgetTabSources",
    bills:          "budgetTabBills",
    categories:     "budgetTabCategories",
    expenseSources: "budgetTabExpenseSources",
    preferences:    "budgetTabPreferences",
  },
});

function applyBudgetSettings(): void {
  budgetQuickDeleteToggle.checked = appSettings.quickDelete;
  budgetQuickDeleteLabel.textContent = appSettings.quickDelete ? "On" : "Off";
  budgetShowClearedToggle.checked = appSettings.showCleared;
  budgetShowClearedLabel.textContent = appSettings.showCleared ? "On" : "Off";
  budgetStartupModeSelect.value = appSettings.startupMode;
  applyBudgetReminderSettings();
  _applyEncryptionSettingsUI();
}

/** Syncs every reminder control to appSettings: the enable toggle and its
 *  collapse, which schedule row is showing, and the Gentle/Aggressive label. */
function applyBudgetReminderSettings(): void {
  budgetReminderToggle.checked = appSettings.reminderEnabled;
  budgetReminderLabel.textContent = appSettings.reminderEnabled ? "On" : "Off";
  // Room for the schedule select, one schedule row, the mode row, and the hint.
  budgetReminderSubsettings.style.maxHeight = appSettings.reminderEnabled
    ? "300px"
    : "0";

  const monthly = appSettings.reminderMode === "monthly";
  budgetReminderModeSelect.value = appSettings.reminderMode;
  budgetReminderDaysRow.style.display = monthly ? "none" : "";
  budgetReminderMonthDaysRow.style.display = monthly ? "" : "none";
  budgetReminderDaysInput.value = String(appSettings.reminderDays);
  budgetReminderMonthDaysInput.value = appSettings.reminderMonthDays.join(", ");

  budgetReminderAggressiveToggle.checked = appSettings.reminderAggressive;
  budgetReminderModeLabel.textContent = appSettings.reminderAggressive
    ? "Aggressive"
    : "Gentle";
}

function openSetupModalOnTab(tab?: SetupTab): void {
  // Selecting before opening beats letting the modal restore its own tab, so
  // a deep link lands where it asked even on the very first open.
  if (tab) setupTabs.select(tab);
  getSetupModal().open();
}

let setupModal: Modal | null = null;

function getSetupModal(): Modal {
  if (!setupModal) {
    setupModal = new Modal(document.getElementById("budgetSetupBackdrop")!, {
      closeOnEsc: true,
      tabs: setupTabs,
      onOpen: () => {
        renderSimpleList("sources");
        renderBillsList();
        renderSimpleList("categories");
        renderSimpleList("expenseSources");
        applyBudgetSettings();
      },
    });

    document
      .getElementById("budgetSetupClose")!
      .addEventListener("click", () => setupModal!.close());
  }
  return setupModal;
}

/* =============================================================================
   DATA LOAD WARNING MODAL
   -----------------------------------------------------------------------------
   Shown when loadFromDisk() encountered bad data. The window always opens
   normally. This modal appears shortly after as a non-blocking notification.
   "Reset Data" wipes the bad file and saves a clean empty state so it never
   shows again. "Keep Working" dismisses and lets the user continue with the
   empty-data fallback for this session.
============================================================================= */

let dataLoadWarningModal: Modal | null = null;

function getDataLoadWarningModal(): Modal {
  if (!dataLoadWarningModal) {
    dataLoadWarningModal = new Modal(
      document.getElementById("budgetDataLoadWarningBackdrop")!,
      { closeOnEsc: false }, // force an explicit choice
    );
    document
      .getElementById("budgetDataWarnResetBtn")!
      .addEventListener("click", async () => {
        data = emptyData();
        try {
          await saveToDisk();
        } catch (e) {
          flash(`Failed to save the reset budget: ${e}`, "error", 8000);
          return; // keep the warning modal open. Nothing was written
        }
        loadError = null;
        dataLoadWarningModal!.close();
        renderAll();
        flash("Budget data reset to empty", "success");
      });
    document
      .getElementById("budgetDataWarnKeepBtn")!
      .addEventListener("click", () => {
        dataLoadWarningModal!.close();
      });
  }
  return dataLoadWarningModal;
}

function openDataLoadWarning(reason: string): void {
  const el = document.getElementById("budgetDataWarnReason");
  if (el) el.textContent = reason;
  getDataLoadWarningModal().open();
}

/* =============================================================================
   INIT: EXPORTED ENTRY POINT
============================================================================= */

export async function initBudget(): Promise<void> {
  // Check encryption status before touching any data
  const lockStatus = await invoke<{ enabled: boolean; sessionUnlock: boolean }>(
    "budget_lock_status"
  ).catch(() => ({ enabled: false, sessionUnlock: false }));

  encryptionEnabled = lockStatus.enabled;
  sessionUnlockMode = lockStatus.sessionUnlock;

  // Ahead of the encryption gate on purpose. Reminder state lives in Budget's
  // (unencrypted) settings file precisely so an encrypted budget can still say
  // "you haven't updated me in a while" at startup, with this after the gate,
  // that would never happen until the user typed their password. _continueInit
  // loads these again; the read is cheap and idempotent.
  await loadAppSettings();
  refreshBudgetDueUI();

  if (encryptionEnabled) {
    // Bind gate listeners now (once). The gate itself stays hidden until
    // shown below or by a later onBudgetToolEntry() navigation call.
    _bindAuthGate();

    // loadShellState() (called in parallel with initBudget() during app
    // startup) may have already restored the Budget tool as the active view
    // BEFORE encryptionEnabled was known, in which case onBudgetToolEntry()
    // ran too early and saw encryptionEnabled === false, so it no-opped and
    // the gate never appeared. Detect that race here: if the Budget tool
    // view is currently the visible one, treat this as tool entry now.
    const budgetView = document.getElementById("finance-tool-budget");
    const isBudgetCurrentlyActive =
      budgetView !== null && budgetView.style.display !== "none";

    if (isBudgetCurrentlyActive) {
      onBudgetToolEntry();
    }
    return;
  }

  await _continueInit();
}

/**
 * Called after authentication is confirmed (or immediately on first run
 * when encryption is off). Loads data every time (it needs to reflect
 * whatever was just decrypted), but binds DOM/event listeners exactly once
 *. This used to run its entire body, listeners included, on every
 * re-entry. Since the Budget tool's DOM is never destroyed (shell.ts just
 * toggles display:none), every re-auth was stacking a fresh, uncleared
 * listener onto the same buttons: 2 clicks did 2x, 3 re-entries did 3x, and
 * so on, on every button bound here, not just the ones anyone happened to
 * notice. _continueInitBound below is the fix, same pattern as
 * _authGateBound just below it.
 */
let _continueInitBound = false;

async function _continueInit(): Promise<void> {
  await Promise.all([loadFromDisk(), loadAppSettings()]);

  if (!_continueInitBound) {
    _continueInitBound = true;

    // Range navigation
    monthLabelEl = document.getElementById("budgetMonthLabel")!;
    monthInputEl = document.getElementById(
      "budgetMonthInput",
    ) as HTMLInputElement;
    monthPrevBtn = document.getElementById(
      "budgetMonthPrev",
    ) as HTMLButtonElement;
    monthNextBtn = document.getElementById(
      "budgetMonthNext",
    ) as HTMLButtonElement;
    snapBtnEl = document.getElementById("budgetSnapBtn") as HTMLButtonElement;
    viewModeBtns = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "#finance-tool-budget .budget-view-mode-btn",
      ),
    );
    budgetStartupModeSelect = document.getElementById(
      "budgetStartupModeSelect",
    ) as HTMLSelectElement;

    // Entry type toggle
    typeIncomeBtn = document.getElementById(
      "budgetTypeIncomeBtn",
    ) as HTMLButtonElement;
    typeExpenseBtn = document.getElementById(
      "budgetTypeExpenseBtn",
    ) as HTMLButtonElement;
    incomeFieldsEl = document.getElementById("budgetIncomeFields")!;
    expenseFieldsEl = document.getElementById("budgetExpenseFields")!;

    // Income fields
    incomeDateInput = document.getElementById(
      "budgetIncomeDate",
    ) as HTMLInputElement;
    incomeSourceInput = document.getElementById(
      "budgetIncomeSource",
    ) as HTMLInputElement;
    incomeExpectedInput = document.getElementById(
      "budgetIncomeExpected",
    ) as HTMLInputElement;
    incomeActualInput = document.getElementById(
      "budgetIncomeActual",
    ) as HTMLInputElement;
    incomeNotesInput = document.getElementById(
      "budgetIncomeNotes",
    ) as HTMLInputElement;
    addIncomeBtn = document.getElementById(
      "budgetAddIncomeBtn",
    ) as HTMLButtonElement;

    // Expense fields
    expenseDateInput = document.getElementById(
      "budgetExpenseDate",
    ) as HTMLInputElement;
    expenseCategoryInput = document.getElementById(
      "budgetExpenseCategory",
    ) as HTMLInputElement;
    expenseSourceInput = document.getElementById(
      "budgetExpenseSource",
    ) as HTMLInputElement;
    expenseAmountInput = document.getElementById(
      "budgetExpenseAmount",
    ) as HTMLInputElement;
    expenseNotesInput = document.getElementById(
      "budgetExpenseNotes",
    ) as HTMLInputElement;
    addExpenseBtn = document.getElementById(
      "budgetAddExpenseBtn",
    ) as HTMLButtonElement;

    // Datalists
    sourceDatalist = document.getElementById(
      "budgetSourceList",
    ) as HTMLDataListElement;
    categoryDatalist = document.getElementById(
      "budgetCategoryList",
    ) as HTMLDataListElement;
    expenseSourceDatalist = document.getElementById(
      "budgetExpenseSourceList",
    ) as HTMLDataListElement;

    // Panels
    totalsEl = document.getElementById("budgetTotals")!;
    categorySummaryEl = document.getElementById("budgetCategorySummary")!;
    sourceSummaryEl = document.getElementById("budgetSourceSummary")!;
    billsEl = document.getElementById("budgetBills")!;
    overdueBadgeEl = document.getElementById("budgetOverdueBadge")!;
    entriesEl = document.getElementById("budgetEntries")!;
    ledgerSortSelect = document.getElementById("budgetLedgerSortSelect") as HTMLSelectElement;
    ledgerSortSelect.addEventListener("change", () => {
      ledgerSortMode = ledgerSortSelect.value as LedgerSortMode;
      renderEntries();
    });

    // Mark Paid / Edit Payment modal
    billActionTitleEl = document.getElementById("budgetBillActionTitle")!;
    billActionSubtitleEl = document.getElementById("budgetBillActionSubtitle")!;
    billActionDetailsEl = document.getElementById("budgetBillActionDetails")!;
    billActionAmountInput = document.getElementById(
      "budgetBillActionAmount",
    ) as HTMLInputElement;
    billActionDateInput = document.getElementById(
      "budgetBillActionDate",
    ) as HTMLInputElement;
    billActionClearedCheckbox = document.getElementById(
      "budgetBillActionCleared",
    ) as HTMLInputElement;
    billActionClearedDateField = document.getElementById(
      "budgetBillActionClearedDateField",
    )!;
    billActionClearedRowEl = document.getElementById(
      "budgetBillActionClearedRow",
    )!;
    billActionClearedDateInput = document.getElementById(
      "budgetBillActionClearedDate",
    ) as HTMLInputElement;
    billActionNotesInput = document.getElementById(
      "budgetBillActionNotes",
    ) as HTMLInputElement;
    billActionNextDueField = document.getElementById(
      "budgetBillActionNextDueField",
    )!;
    billActionNextDueInput = document.getElementById(
      "budgetBillActionNextDue",
    ) as HTMLInputElement;
    billActionSaveBtn = document.getElementById(
      "budgetBillActionSaveBtn",
    ) as HTMLButtonElement;
    billActionUndoBtn = document.getElementById(
      "budgetBillActionUndoBtn",
    ) as HTMLButtonElement;
    billActionCancelBtn = document.getElementById(
      "budgetBillActionCancelBtn",
    ) as HTMLButtonElement;
    billActionCloseBtn = document.getElementById(
      "budgetBillActionClose",
    ) as HTMLButtonElement;

    // Setup modal, simple lists
    categoriesListEl = document.getElementById("budgetCategoriesList")!;
    sourcesListEl = document.getElementById("budgetSourcesList")!;
    expenseSourcesListEl = document.getElementById("budgetExpenseSourcesList")!;
    categoryNewBtn = document.getElementById("budgetCategoryNewBtn") as HTMLButtonElement;
    sourceNewBtn = document.getElementById("budgetSourceNewBtn") as HTMLButtonElement;
    expenseSourceNewBtn = document.getElementById("budgetExpenseSourceNewBtn") as HTMLButtonElement;

    // Setup modal, recurring bills list
    billsListEl = document.getElementById("budgetBillsList")!;
    billNewBtn = document.getElementById("budgetBillNewBtn") as HTMLButtonElement;

    // Bill Editor modal
    billEditTitleEl = document.getElementById("budgetBillEditTitle")!;
    billNameInput = document.getElementById("budgetBillName") as HTMLInputElement;
    billTypeSelect = document.getElementById(
      "budgetBillType",
    ) as HTMLSelectElement;
    billAmountInput = document.getElementById(
      "budgetBillAmount",
    ) as HTMLInputElement;
    billIntervalInput = document.getElementById(
      "budgetBillInterval",
    ) as HTMLInputElement;
    billUnitSelect = document.getElementById(
      "budgetBillUnit",
    ) as HTMLSelectElement;
    billNextDueInput = document.getElementById(
      "budgetBillNextDue",
    ) as HTMLInputElement;
    billPayMethodInput = document.getElementById(
      "budgetBillPayMethod",
    ) as HTMLInputElement;
    billAutopayCheckbox = document.getElementById(
      "budgetBillAutopay",
    ) as HTMLInputElement;
    billAutopayLabelEl = document.getElementById("budgetBillAutopayLabel")!;

    // Mark Paid modal, cleared toggle label
    billActionClearedLabelEl = document.getElementById(
      "budgetBillActionClearedLabel",
    )!;

    // Delete entry confirm modal, specific message
    deleteMessageEl = document.getElementById("budgetDeleteMessage")!;

    // Budget Settings tab
    budgetQuickDeleteToggle = document.getElementById(
      "budgetQuickDeleteToggle",
    ) as HTMLInputElement;
    budgetQuickDeleteLabel = document.getElementById("budgetQuickDeleteLabel")!;
    budgetShowClearedToggle = document.getElementById(
      "budgetShowClearedToggle",
    ) as HTMLInputElement;
    budgetShowClearedLabel = document.getElementById("budgetShowClearedLabel")!;
    budgetReminderToggle = document.getElementById(
      "budgetReminderToggle",
    ) as HTMLInputElement;
    budgetReminderLabel = document.getElementById("budgetReminderLabel")!;
    budgetReminderSubsettings = document.getElementById("budgetReminderSubsettings")!;
    budgetReminderModeSelect = document.getElementById(
      "budgetReminderModeSelect",
    ) as HTMLSelectElement;
    budgetReminderDaysRow = document.getElementById("budgetReminderDaysRow")!;
    budgetReminderDaysInput = document.getElementById(
      "budgetReminderDays",
    ) as HTMLInputElement;
    budgetReminderMonthDaysRow = document.getElementById("budgetReminderMonthDaysRow")!;
    budgetReminderMonthDaysInput = document.getElementById(
      "budgetReminderMonthDays",
    ) as HTMLInputElement;
    budgetReminderAggressiveToggle = document.getElementById(
      "budgetReminderAggressiveToggle",
    ) as HTMLInputElement;
    budgetReminderModeLabel = document.getElementById("budgetReminderModeLabel")!;
    billNotesInput = document.getElementById(
      "budgetBillNotes",
    ) as HTMLInputElement;
    billSaveBtn = document.getElementById(
      "budgetBillSaveBtn",
    ) as HTMLButtonElement;
    billRetireBtn = document.getElementById(
      "budgetBillRetireBtn",
    ) as HTMLButtonElement;
    billDeleteBtn = document.getElementById(
      "budgetBillDeleteBtn",
    ) as HTMLButtonElement;
    billCancelBtn = document.getElementById(
      "budgetBillCancelBtn",
    ) as HTMLButtonElement;
    billBackBtn = document.getElementById("budgetBillBack") as HTMLButtonElement;
    billCloseBtn = document.getElementById(
      "budgetBillEditClose",
    ) as HTMLButtonElement;

    // Default both date pickers to today on load
    incomeDateInput.value = today();
    expenseDateInput.value = today();

    /* -------------------------------------------------------------------------
       VIEW MODE BUTTONS (Day / Week / Month / Year)
    -------------------------------------------------------------------------- */

    viewModeBtns.forEach((btn) => {
      btn.addEventListener("click", () =>
        setViewMode(btn.dataset.view as ViewMode),
      );
    });

    /* -------------------------------------------------------------------------
       RANGE NAVIGATION (← prev, → next, snap, inline edit)
    -------------------------------------------------------------------------- */

    monthPrevBtn.addEventListener("click", () => shiftRange(-1));
    monthNextBtn.addEventListener("click", () => shiftRange(1));
    snapBtnEl.addEventListener("click", () => snapToCurrent());

    // Click the label to edit the range inline
    monthLabelEl.addEventListener("click", () => {
      monthLabelEl.style.display = "none";
      monthInputEl.value = monthLabelEl.textContent || "";
      monthInputEl.style.display = "";
      monthInputEl.focus();
      monthInputEl.select();
    });

    monthInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        commitRangeInput();
      } else if (e.key === "Escape") {
        monthInputEl.style.display = "none";
        monthLabelEl.style.display = "";
      }
    });

    monthInputEl.addEventListener("blur", commitRangeInput);

    /* -------------------------------------------------------------------------
       ENTRY TYPE TOGGLE
    -------------------------------------------------------------------------- */

    typeIncomeBtn.addEventListener("click", () => setEntryType("income"));
    typeExpenseBtn.addEventListener("click", () => setEntryType("expense"));

    /* -------------------------------------------------------------------------
       ADD ENTRY
    -------------------------------------------------------------------------- */

    addIncomeBtn.addEventListener("click", addIncomeEntry);
    addExpenseBtn.addEventListener("click", addExpenseEntry);
    bindEnterToSubmit(incomeFieldsEl, addIncomeBtn);
    bindEnterToSubmit(expenseFieldsEl, addExpenseBtn);

    // Mirror Expected → Actual until the user edits Actual directly.
    incomeExpectedInput.addEventListener("input", () => {
      if (!actualTouched) incomeActualInput.value = incomeExpectedInput.value;
    });
    incomeActualInput.addEventListener("input", () => {
      actualTouched = true;
    });

    /* -------------------------------------------------------------------------
       SETUP MODAL
    -------------------------------------------------------------------------- */

    document.getElementById("budgetSetupBtn")!.addEventListener("click", () => {
      // No tab to pick: ModalTabs forgets the selected tab on a real close, so
      // a fresh open from the main view lands on Income Sources on its own.
      // Intra-modal transitions (bill editor, delete confirm) never close the
      // modal for real, so they come back to the tab they left.
      getSetupModal().open();
    });

    // Annual Stats toggle
    document
      .getElementById("budgetAnnualStatsBtn")!
      .addEventListener("click", () => toggleAnnualStats());

    // Summary panel tabs, scoped for the same reason activateSummaryTab's own
    // query is (see the note there).
    document
      .querySelectorAll<HTMLButtonElement>(".budget-summary-tabs .budget-summary-tab")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          // The cast below can't vouch for the attribute actually being there,
          // so check before trusting it rather than passing undefined on.
          const tab = btn.dataset.summaryTab;
          if (!tab) return;
          activateSummaryTab(tab as SummaryTab);
        });
      });

    // Chart cycle buttons, toggle bar ↔ pie, update label, redraw
    document.getElementById("budgetCategoryChartCycleBtn")!.addEventListener("click", () => {
      categoryChartType = categoryChartType === "bar" ? "pie" : "bar";
      renderCategorySummary();
    });
    document.getElementById("budgetSourceChartCycleBtn")!.addEventListener("click", () => {
      sourceChartType = sourceChartType === "bar" ? "pie" : "bar";
      renderSourceSummary();
    });

    // Chart expand buttons, open the chart in a modal
    document.getElementById("budgetCategoryChartExpandBtn")!.addEventListener("click", () => {
      openChartModal("category");
    });
    document.getElementById("budgetSourceChartExpandBtn")!.addEventListener("click", () => {
      openChartModal("source");
    });

    // Modal chart cycle button, toggles type and redraws without closing
    document.getElementById("budgetChartExpandCycleBtn")!.addEventListener("click", () => {
      if (_chartModalGrouping === "category") {
        categoryChartType = categoryChartType === "bar" ? "pie" : "bar";
      } else {
        sourceChartType = sourceChartType === "bar" ? "pie" : "bar";
      }
      drawModalChart();
      // Also sync the inline summary panel cycle button
      if (_chartModalGrouping === "category") renderCategorySummary();
      else renderSourceSummary();
    });

    // Categories / Income Sources / Expense Sources, "+ New" buttons open per-type add modals
    sourceNewBtn.addEventListener("click", openSourceAdd);
    categoryNewBtn.addEventListener("click", openCategoryAdd);
    expenseSourceNewBtn.addEventListener("click", openExpSourceAdd);

    // Recurring bills, "+ New Bill" opens the Bill Editor modal blank, in
    // place of the Setup modal (closes Setup, opens the editor).
    billNewBtn.addEventListener("click", startNewBill);

    /* -------------------------------------------------------------------------
       BUDGET SETTINGS TOGGLES (item 10)
    -------------------------------------------------------------------------- */

    budgetQuickDeleteToggle.addEventListener("change", () => {
      appSettings.quickDelete = budgetQuickDeleteToggle.checked;
      budgetQuickDeleteLabel.textContent = appSettings.quickDelete ? "On" : "Off";
      saveAppSettings();
      renderEntries(); // re-render so delete buttons appear/disappear
    });

    budgetShowClearedToggle.addEventListener("change", () => {
      appSettings.showCleared = budgetShowClearedToggle.checked;
      budgetShowClearedLabel.textContent = appSettings.showCleared ? "On" : "Off";
      saveAppSettings();
      renderBills(); // cleared status visibility changes on bill rows
      // Also apply to the Pay modal's cleared row in case it's open
      billActionClearedRowEl.style.display = appSettings.showCleared
        ? ""
        : "none";
    });

    budgetStartupModeSelect.addEventListener("change", () => {
      appSettings.startupMode = budgetStartupModeSelect.value as
        | "current-month"
        | "last-view";
      saveAppSettings();
      if (appSettings.startupMode === "last-view") saveLastView();
    });

    /* -------------------------------------------------------------------------
       BUDGET REMINDERS
       Every handler ends the same way, persist, re-sync the controls (which
       also swaps the schedule row), and refresh the due signals so a settings
       change is reflected in the sidebar and header immediately rather than at
       next launch.
    -------------------------------------------------------------------------- */

    budgetReminderToggle.addEventListener("change", () => {
      appSettings.reminderEnabled = budgetReminderToggle.checked;
      // Deliberately does NOT stamp lastUpdatedAt. Starting the clock at the
      // moment you switch this on tells a budget that's been untouched for a
      // month that it's perfectly current, which is the opposite of what
      // turning on a reminder is for, budgetBaselineAt() reads the real state
      // from the data instead.
      saveAppSettings();
      applyBudgetReminderSettings();
      refreshBudgetDueUI();
    });

    budgetReminderModeSelect.addEventListener("change", () => {
      appSettings.reminderMode =
        budgetReminderModeSelect.value === "monthly" ? "monthly" : "interval";
      saveAppSettings();
      applyBudgetReminderSettings();
      refreshBudgetDueUI();
    });

    budgetReminderDaysInput.addEventListener("change", () => {
      const n = Math.round(parseFloat(budgetReminderDaysInput.value));
      appSettings.reminderDays = Number.isFinite(n)
        ? Math.min(366, Math.max(1, n))
        : 7;
      saveAppSettings();
      applyBudgetReminderSettings(); // reflects any clamping back into the field
      refreshBudgetDueUI();
    });

    budgetReminderMonthDaysInput.addEventListener("change", () => {
      // An entry that yields nothing usable falls back to the 1st rather than
      // leaving a schedule that can't fire.
      const parsed = parseMonthDaysInput(budgetReminderMonthDaysInput.value);
      appSettings.reminderMonthDays = parsed.length > 0 ? parsed : [1];
      saveAppSettings();
      applyBudgetReminderSettings(); // rewrites the field in its cleaned form
      refreshBudgetDueUI();
    });

    budgetReminderAggressiveToggle.addEventListener("change", () => {
      appSettings.reminderAggressive = budgetReminderAggressiveToggle.checked;
      saveAppSettings();
      applyBudgetReminderSettings();
    });

    document
      .getElementById("budgetDueClearBtn")!
      .addEventListener("click", () => getReviewConfirmModal().open());

    document.getElementById("budgetReviewConfirmBtn")!.addEventListener("click", () => {
      getReviewConfirmModal().close();
      markBudgetReviewed();
      flash("Budget marked as reviewed", "success");
    });

    document
      .getElementById("budgetReviewCancelBtn")!
      .addEventListener("click", () => getReviewConfirmModal().close());

    // Encryption settings
    document.getElementById("budgetEncryptEnableBtn")?.addEventListener("click", openEncryptionEnableModal);
    document.getElementById("budgetEncryptDisableBtn")?.addEventListener("click", openEncryptionDisableModal);

    // Theme change listener, redraws chart canvases whenever the active theme
    // changes, since chart colors are read from CSS vars at draw time.
    window.addEventListener("themechange", () => {
      // Defer one rAF so the browser has committed the new CSS custom properties
      // to computed styles before getChartPalette() reads them back.
      requestAnimationFrame(() => {
        if (activeSummaryTab === "category") {
          const c = document.getElementById("budgetCategoryChart") as HTMLCanvasElement | null;
          if (c && c.width > 0) {
            const entries = buildChartEntries("category");
            const result = drawSummaryChart(c, entries, categoryChartType);
            attachChartTooltip(c, result, categoryChartType);
          }
        } else if (activeSummaryTab === "source") {
          const c = document.getElementById("budgetSourceChart") as HTMLCanvasElement | null;
          if (c && c.width > 0) {
            const entries = buildChartEntries("source");
            const result = drawSummaryChart(c, entries, sourceChartType);
            attachChartTooltip(c, result, sourceChartType);
          }
        }
        if (getChartModal().isOpen) drawModalChart();
      });
    });

    // Resize listener, redraws charts when the window size changes so the
    // canvas always fits without overflow or blank space.
    // Debounced at 150ms so rapid resize events don't cause excessive redraws.
    let _resizeTimer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener("resize", () => {
      if (_resizeTimer) clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => {
        // Redraw inline summary chart if one of the chart tabs is active
        if (activeSummaryTab === "category") renderCategorySummary();
        else if (activeSummaryTab === "source") renderSourceSummary();

        // Redraw modal chart if the chart expand modal is currently open
        if (getChartModal().isOpen) drawModalChart();
      }, 150);
    });
  }

  /* -------------------------------------------------------------------------
     INITIAL RENDER
  -------------------------------------------------------------------------- */

  setEntryType("income");
  refreshDatalists();

  // Initialize view state
  const now = new Date();
  viewYear = now.getFullYear();
  viewMonth = now.getMonth();
  viewDay = now.getDate();
  viewWeekStart = localDateString(mondayOf(now));
  viewMode = "month"; // default

  if (appSettings.startupMode === "last-view") {
    restoreLastView();
  }

  // Initialize the snap button label and view mode button states
  snapBtnEl.textContent = SNAP_LABELS[viewMode];
  viewModeBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === viewMode);
  });

  renderRangeNav();
  renderAll();

  // The data half of the baseline is readable from here on. On an encrypted
  // budget this is the first point where it is (initBudget() ran its refresh
  // before the auth gate, when `data` was still empty) so cache it for the
  // next startup and re-evaluate the signals against the real numbers.
  syncDataNewestAt();
  refreshBudgetDueUI();

  // If the saved data file was unreadable or had an unrecoverable structure,
  // show the in-app warning. This runs AFTER the window is visible (shell.ts
  // calls window.show() after awaiting initBudget), so we use a short
  // setTimeout to let the window paint first before opening the modal.
  if (loadError) {
    window.setTimeout(() => openDataLoadWarning(loadError!), 300);
  }
}

/* =============================================================================
   BUDGET AUTH GATE
   -----------------------------------------------------------------------------
   A view within the Budget tool itself, a sibling of #budgetToolContent
   inside #finance-tool-budget, exactly like any other internal tool panel.
   It lives and dies with the tool's own visibility: shell.ts shows/hides
   #finance-tool-budget exactly as it always has, and the gate (or the tool
   content) is shown/hidden within that based on auth state. No positioning
   tricks, no observers, no shell.ts coupling beyond the existing
   onBudgetToolEntry() call already wired into activateTool().

   On successful auth, the gate is hidden and _continueInit() completes tool
   startup. On re-entry (sessionUnlockMode = false): the gate is shown again
   each time the user navigates to the Budget tool, and in-memory data is
   cleared until re-authenticated.
============================================================================= */

let _authGateBound = false;

// Cached DOM refs for the auth gate, resolved once on first bind.
let _agGate: HTMLElement;
let _agToolContent: HTMLElement;
let _agAuthView: HTMLElement;
let _agInput: HTMLInputElement;
let _agSubmitBtn: HTMLButtonElement;
let _agSpinner: HTMLElement;
let _agIconLocked: HTMLElement;
let _agIconUnlocked: HTMLElement;

/**
 * Wires all auth gate event listeners exactly once during initBudget().
 * Does NOT show the gate, that's _showAuthGate()'s job.
 */
function _bindAuthGate(): void {
  if (_authGateBound) return;
  _authGateBound = true;

  _agGate        = document.getElementById("budgetAuthGate")!;
  _agToolContent = document.getElementById("budgetToolContent")!;
  _agAuthView    = document.getElementById("budgetAuthView")!;
  _agInput       = document.getElementById("budgetAuthInput") as HTMLInputElement;
  _agSubmitBtn   = document.getElementById("budgetAuthSubmitBtn") as HTMLButtonElement;
  _agSpinner     = document.getElementById("budgetAuthSpinner")!;
  _agIconLocked  = document.getElementById("budgetAuthIconLocked")!;
  _agIconUnlocked = document.getElementById("budgetAuthIconUnlocked")!;

  const showBtn = document.getElementById("budgetAuthShowBtn")!;
  const homeBtn = document.getElementById("budgetAuthHomeBtn") as HTMLButtonElement;

  showBtn.addEventListener("click", () => {
    _agInput.type = _agInput.type === "password" ? "text" : "password";
  });

  homeBtn.addEventListener("click", () => {
    // Clicking the Home nav item hides #finance-tool-budget, which takes
    // this gate down with it automatically. No manual hide needed.
    const homeNavItem = document.querySelector<HTMLElement>(".nav-item[data-section='home']");
    homeNavItem?.click();
  });

  async function attemptAuth(): Promise<void> {
    const pw = _agInput.value;
    if (!pw) return;
    _agSubmitBtn.disabled = true;
    _agInput.classList.remove("lock-input-error");
    try {
      const ok = await invoke<boolean>("budget_verify_password", { password: pw });
      if (ok) {
        sessionPassword = pw;
        sessionUnlocked = true;
        _agInput.value = "";
        // Switch to unlocked icon + spinner while data loads
        _agIconLocked.style.display = "none";
        _agIconUnlocked.style.display = "";
        _agAuthView.style.display = "none";
        _agSpinner.style.display = "";
        await _continueInit();
        // Data loaded, hide gate, show tool
        _agGate.style.display = "none";
        _agToolContent.style.display = "";
        // Reset gate state for next entry
        _agAuthView.style.display = "";
        _agSpinner.style.display = "none";
        _agIconLocked.style.display = "";
        _agIconUnlocked.style.display = "none";
        _agSubmitBtn.disabled = false;
      } else {
        flash("Incorrect password", "error");
        _agInput.classList.add("lock-input-error");
        _agInput.select();
        _agSubmitBtn.disabled = false;
      }
    } catch (e) {
      flash(`Authentication error: ${e}`, "error");
      // If the failure happened AFTER a successful verify (i.e. inside
      // _continueInit), the gate is mid-transition: auth view hidden, spinner
      // showing. Without restoring it here the user is stuck staring at a
      // spinner forever with no input to retry from.
      _agAuthView.style.display = "";
      _agSpinner.style.display = "none";
      _agIconLocked.style.display = "";
      _agIconUnlocked.style.display = "none";
      _agSubmitBtn.disabled = false;
    }
  }

  _agSubmitBtn.addEventListener("click", attemptAuth);
  _agInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") attemptAuth();
  });
}

/**
 * Shows the auth gate over the tool content. Always resets visual state
 * so it looks clean whether this is the first or a subsequent entry.
 * Called by onBudgetToolEntry() only, never called during startup.
 */
function _showAuthGate(): void {
  _agGate.style.display = "flex";
  _agToolContent.style.display = "none";
  _agAuthView.style.display = "";
  _agSpinner.style.display = "none";
  _agIconLocked.style.display = "";
  _agIconUnlocked.style.display = "none";
  _agInput.value = "";
  _agInput.type = "password";
  _agInput.classList.remove("lock-input-error");
  _agInput.focus();
}

/**
 * Called by shell.ts when the user navigates to the Budget tool.
 * If session-unlock mode is on and already unlocked this session, does nothing.
 * Otherwise clears in-memory data and shows the auth gate.
 */
export function onBudgetToolEntry(): void {
  if (!encryptionEnabled) return;
  if (sessionUnlockMode && sessionUnlocked) return;

  // Flush any pending debounced save BEFORE clearing state below. Navigation
  // away from the tool already flushes (shell.ts switchSection), but this
  // covers re-entry paths that never leave the view, e.g. re-clicking the
  // Budget sidebar icon within SAVE_DEBOUNCE_MS of an edit. saveToDisk()
  // snapshots the data and password synchronously, so wiping them on the
  // next lines cannot corrupt the write that was just kicked off.
  void flushQueuedSave();

  // Clear in-memory data before showing gate
  data = emptyData();
  sessionPassword = "";
  sessionUnlocked = false;
  _showAuthGate();
}

/* =============================================================================
   OS SESSION LOCK  →  BUDGET RE-LOCK
   -----------------------------------------------------------------------------
   Windows session lock/unlock (Win+L, the lock key, idle lock) isn't visible
   to the DOM in any reliable way, so the Rust side watches for it directly
   (WM_WTSSESSION_CHANGE, see src-tauri/src/session_watch.rs) and emits
   "session-lock-changed". When re-auth-on-every-entry is the active
   encryption mode and there's a live authenticated session, an OS lock
   force-relocks the budget exactly like navigating away and back, and on
   unlock, flashes the taskbar so the re-auth prompt isn't missed (without
   stealing focus outright). Mirrors how a password manager like Bitwarden
   re-locks its vault with the machine.
============================================================================= */

let _relockedByOsLock = false;

listen<boolean>("session-lock-changed", async (event) => {
  if (event.payload) {
    if (encryptionEnabled && !sessionUnlockMode && sessionUnlocked) {
      onBudgetToolEntry();
      _relockedByOsLock = true;
    }
  } else if (_relockedByOsLock) {
    _relockedByOsLock = false;
    await getCurrentWindow().requestUserAttention(UserAttentionType.Critical).catch(() => {});
  }
}).catch(() => {});

/* =============================================================================
   ENCRYPTION SETTINGS: Enable / Disable flows
   -----------------------------------------------------------------------------
   These modals replace the Setup modal (replaceModal option) rather than
   stacking on top of it. Back-arrow and Cancel return to Setup; the X closes
   entirely. Inputs are cleared on every open via the onOpen hook.
============================================================================= */

function openEncryptionEnableModal(): void {
  getEncryptionEnableModal().open();
}

function openEncryptionDisableModal(): void {
  getEncryptionDisableModal().open();
}

let encryptionEnableModal: Modal | null = null;

function getEncryptionEnableModal(): Modal {
  if (!encryptionEnableModal) {
    const pwInput = document.getElementById("budgetEncryptNewPassword") as HTMLInputElement;
    const confirmInput = document.getElementById("budgetEncryptConfirmPassword") as HTMLInputElement;
    const showBtn = document.getElementById("budgetEncryptShowBtn")!;
    const confirmBtn = document.getElementById("budgetEncryptEnableConfirmBtn") as HTMLButtonElement;
    const cancelBtn = document.getElementById("budgetEncryptEnableCancelBtn") as HTMLButtonElement;
    const backBtn = document.getElementById("budgetEncryptEnableBackBtn")!;
    const closeBtn = document.getElementById("budgetEncryptEnableCloseBtn")!;

    encryptionEnableModal = new Modal(
      document.getElementById("budgetEncryptEnableBackdrop")!,
      {
        closeOnEsc: true,
        replaceModal: getSetupModal(),
        onOpen: () => {
          pwInput.value = "";
          confirmInput.value = "";
          pwInput.type = "password";
          confirmInput.type = "password";
          // Reset toggle and label to default (re-auth every entry)
          if (sessionToggleEl) sessionToggleEl.checked = true;
          if (sessionLabelEl) sessionLabelEl.textContent = "On every tool entry";
          pwInput.focus();
        },
      }
    );

    const confirmShowBtn = document.getElementById("budgetEncryptConfirmShowBtn")!;
    const sessionToggleEl = document.getElementById("budgetEncryptSessionToggle") as HTMLInputElement;
    const sessionLabelEl = document.getElementById("budgetEncryptSessionLabel");

    showBtn.addEventListener("click", () => {
      const t = pwInput.type === "password" ? "text" : "password";
      pwInput.type = t;
      confirmInput.type = t;
    });
    // Confirm field has its own independent show button (same visual toggle)
    confirmShowBtn.addEventListener("click", () => {
      const t = confirmInput.type === "password" ? "text" : "password";
      confirmInput.type = t;
    });
    // Re-auth toggle, update the descriptive label as it changes
    sessionToggleEl?.addEventListener("change", () => {
      if (sessionLabelEl) {
        sessionLabelEl.textContent = sessionToggleEl.checked
          ? "On every tool entry"
          : "Only once per session";
      }
    });

    // Back + Cancel both return to Setup; X closes entirely
    const returnToSetup = () => {
      encryptionEnableModal!.close();
      openSetupModalOnTab("preferences");
    };
    backBtn.addEventListener("click", returnToSetup);
    cancelBtn.addEventListener("click", returnToSetup);
    closeBtn.addEventListener("click", () => encryptionEnableModal!.close());

    confirmBtn.addEventListener("click", async () => {
      const pw = pwInput.value;
      const confirm = confirmInput.value;
      if (!pw) { flash("Enter a password", "error"); return; }
      if (pw.length < 8) { flash("Password must be at least 8 characters", "error"); return; }
      if (pw !== confirm) { flash("Passwords do not match", "error"); return; }

      // Read the session-unlock preference from the modal toggle before encrypting.
      // Toggle label: "Re-auth on every entry". checked=true → every entry → sessionUnlock=false.
      const sessionToggle = document.getElementById("budgetEncryptSessionToggle") as HTMLInputElement | null;
      const reAuthEveryEntry = sessionToggle?.checked ?? true;
      const newSessionUnlockMode = !reAuthEveryEntry; // session unlock = NOT re-auth every entry

      confirmBtn.disabled = true;
      try {
        // Flush any queued edit FIRST. The enable command reads the
        // plaintext files from DISK to build the encrypted envelopes, so an
        // edit still in the debounce queue would be missing from them (and
        // the plaintext files it lived in are deleted right after).
        await flushQueuedSave();
        await invoke("budget_enable_encryption", { password: pw });
        // Bind the gate NOW. initBudget() only binds it if encryption was
        // already on at launch, if it's being turned on live, mid-session,
        // that never happens, and the next onBudgetToolEntry() throws trying
        // to touch an unbound _agGate, silently leaving stale content on
        // screen instead of showing the gate. Idempotent, safe either way.
        _bindAuthGate();
        // Only write if non-default (default is every-entry / sessionUnlock=false)
        if (newSessionUnlockMode) {
          await invoke("budget_set_session_unlock", { sessionUnlock: true }).catch(() => {});
        }
        encryptionEnabled = true;
        sessionUnlockMode = newSessionUnlockMode;
        sessionPassword = pw;
        sessionUnlocked = true;
        encryptionEnableModal!.close();
        openSetupModalOnTab("preferences");
        _applyEncryptionSettingsUI();
        flash("Encryption enabled. Budget data is now encrypted on disk.", "success");
      } catch (e) {
        flash(`Failed to enable encryption: ${e}`, "error");
      } finally {
        confirmBtn.disabled = false;
      }
    });
  }
  return encryptionEnableModal;
}

let encryptionDisableModal: Modal | null = null;

function getEncryptionDisableModal(): Modal {
  if (!encryptionDisableModal) {
    const pwInput = document.getElementById("budgetEncryptDisablePassword") as HTMLInputElement;
    const showBtn = document.getElementById("budgetEncryptDisableShowBtn")!;
    const confirmBtn = document.getElementById("budgetEncryptDisableConfirmBtn") as HTMLButtonElement;
    const cancelBtn = document.getElementById("budgetEncryptDisableCancelBtn") as HTMLButtonElement;
    const backBtn = document.getElementById("budgetEncryptDisableBackBtn")!;
    const closeBtn = document.getElementById("budgetEncryptDisableCloseBtn")!;

    encryptionDisableModal = new Modal(
      document.getElementById("budgetEncryptDisableBackdrop")!,
      {
        closeOnEsc: true,
        replaceModal: getSetupModal(),
        onOpen: () => {
          pwInput.value = "";
          pwInput.type = "password";
          pwInput.focus();
        },
      }
    );

    showBtn.addEventListener("click", () => {
      pwInput.type = pwInput.type === "password" ? "text" : "password";
    });

    const returnToSetup = () => {
      encryptionDisableModal!.close();
      openSetupModalOnTab("preferences");
    };
    backBtn.addEventListener("click", returnToSetup);
    cancelBtn.addEventListener("click", returnToSetup);
    closeBtn.addEventListener("click", () => encryptionDisableModal!.close());

    confirmBtn.addEventListener("click", async () => {
      const pw = pwInput.value;
      if (!pw) { flash("Enter your current password", "error"); return; }

      confirmBtn.disabled = true;
      try {
        // Flush any queued edit FIRST. The disable command below decrypts
        // whatever is on disk and rewrites it as plaintext, so an edit still
        // in the debounce queue at this moment would be missing from it.
        await flushQueuedSave();
        await invoke("budget_disable_encryption", { password: pw });
        encryptionEnabled = false;
        sessionPassword = "";
        sessionUnlocked = false;
        encryptionDisableModal!.close();
        openSetupModalOnTab("preferences");
        _applyEncryptionSettingsUI();
        flash("Encryption disabled. Budget data is now stored in plaintext.", "success");
      } catch (e) {
        flash(`Failed to disable encryption: ${e}`, "error");
      } finally {
        confirmBtn.disabled = false;
      }
    });
  }
  return encryptionDisableModal;
}

/** Syncs the encryption section of the Settings tab to current state. */
function _applyEncryptionSettingsUI(): void {
  const statusEl = document.getElementById("budgetEncryptStatus");
  const enableBtn = document.getElementById("budgetEncryptEnableBtn") as HTMLButtonElement | null;
  const disableBtn = document.getElementById("budgetEncryptDisableBtn") as HTMLButtonElement | null;

  if (statusEl) statusEl.textContent = encryptionEnabled ? "Enabled" : "Disabled";
  if (enableBtn) enableBtn.style.display = encryptionEnabled ? "none" : "";
  if (disableBtn) disableBtn.style.display = encryptionEnabled ? "" : "none";
}
