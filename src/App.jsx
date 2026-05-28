import { useState, useEffect, useCallback, useRef } from "react";
import { ref, set, get, onValue } from "firebase/database";
import { db } from "./firebase";



const CATEGORIES = ["食費", "交通費", "娯楽", "日用品", "医療", "交際費", "その他"];
const TASK_CATEGORIES = ["仕事", "家事", "買い物", "健康", "その他"];
const EVENT_TYPES = [
  { key: "salary",  label: "給料日",       color: "#50c878", icon: "💰" },
  { key: "credit",  label: "クレカ支払い", color: "#e07030", icon: "💳" },
  { key: "loan",    label: "ローン返済",   color: "#a060f0", icon: "🏦" },
  { key: "rent",    label: "家賃",         color: "#60c0d0", icon: "🏠" },
  { key: "utility", label: "公共料金",     color: "#60a0f0", icon: "🔌" },
  { key: "other",   label: "その他",       color: "#f0c060", icon: "📌" },
];

const formatMoney = (n) =>
  new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(n);
const today = () => new Date().toISOString().split("T")[0];
const STORAGE_KEY = "life-manager-data";

const FIXED_BUDGET = {
  salary: 280000, lifestyle: "saving", generatedAt: "2026年5月24日",
  advice: "返済を最優先にしたプランです。新規ローン（金利13.6%）を月70,000円で返済し、約20ヶ月での完済を目指します。完済後はNISAを満額再開しましょう。",
  allocations: [
    { category: "既存返済", amount: 30000, reason: "固定・変更不可" },
    { category: "新規返済", amount: 70000, reason: "金利13.6%のため最優先" },
    { category: "食費", amount: 60000, reason: "共同費40,000＋昼食10,000＋外食10,000" },
    { category: "日用品", amount: 13000, reason: "節約目標" },
    { category: "交際費", amount: 30000, reason: "削減後" },
    { category: "交通費", amount: 15000, reason: "自動車・交通費" },
    { category: "娯楽", amount: 7000, reason: "サブスク・娯楽費" },
    { category: "医療", amount: 10000, reason: "医療費" },
    { category: "積立予備費", amount: 15000, reason: "散髪・衣類など不定期支出" },
    { category: "予備費", amount: 10000, reason: "突発出費用" },
    { category: "NISA", amount: 0, reason: "完済まで停止" },
  ],
};

const LOAN_INFO = { principal: 1372166, monthlyPayment: 70000, annualRate: 13.6, startDate: "2026-05-01" };

function calcRepaymentSchedule(principal, monthlyPayment, annualRate, startDateStr) {
  const monthlyRate = annualRate / 100 / 12;
  const schedule = [];
  let balance = principal;
  const start = new Date(startDateStr);
  while (balance > 0) {
    const interest = Math.round(balance * monthlyRate);
    const principalPaid = Math.min(monthlyPayment - interest, balance);
    balance = Math.max(0, balance - principalPaid);
    const d = new Date(start);
    d.setMonth(d.getMonth() + schedule.length);
    schedule.push({ month: schedule.length + 1, date: d.toISOString().slice(0, 7), interest, principalPaid, balance });
    if (schedule.length > 120) break;
  }
  return schedule;
}

// 日本の祝日データ 2026〜2028年
const JP_HOLIDAYS = new Set([
  // 2026年
  "2026-01-01","2026-01-12","2026-02-11","2026-02-23","2026-03-20",
  "2026-04-29","2026-05-03","2026-05-04","2026-05-05","2026-05-06",
  "2026-07-20","2026-08-11","2026-09-21","2026-09-22","2026-09-23",
  "2026-10-12","2026-11-03","2026-11-23","2026-12-23",
  // 2027年
  "2027-01-01","2027-01-11","2027-02-11","2027-02-23","2027-03-21",
  "2027-04-29","2027-05-03","2027-05-04","2027-05-05",
  "2027-07-19","2027-08-11","2027-09-20","2027-09-23",
  "2027-10-11","2027-11-03","2027-11-23",
  // 2028年
  "2028-01-01","2028-01-10","2028-02-11","2028-02-23","2028-03-20",
  "2028-04-29","2028-05-03","2028-05-04","2028-05-05",
  "2028-07-17","2028-08-11","2028-09-18","2028-09-22",
  "2028-10-09","2028-11-03","2028-11-23",
]);

// クレカ締め日→引き落とし月計算
// 例) 締め日5日、支払日5日の場合:
//   12月6日〜1月5日の利用 → 2月5日払い
//   12月1日〜12月5日の利用 → 1月5日払い
function calcPaymentDate(closingDay, payDay, usageDate) {
  const [y, m, d] = usageDate.split("-").map(Number);
  // 利用日が締め日以内 → 当月締め → 翌月払い
  // 利用日が締め日超 → 翌月締め → 翌々月払い
  let payDate;
  if (d <= closingDay) {
    // 当月の締め日までの利用 → 翌月払い
    payDate = new Date(y, m, payDay); // mはJSで0-indexed: new Date(y, m, day) = 翌月のpayDay日
  } else {
    // 締め日を超えた利用 → 翌々月払い
    payDate = new Date(y, m + 1, payDay);
  }
  const payYear = payDate.getFullYear();
  const payMonth = payDate.getMonth() + 1;
  return `${payYear}年${payMonth}月${payDay}日払い`;
}

// 利用日から請求期間の説明を生成
function calcBillingPeriod(closingDay, usageDate) {
  const [y, m, d] = usageDate.split("-").map(Number);
  let periodStart, periodEnd;
  if (d <= closingDay) {
    // 前月の締め日+1〜当月の締め日
    const ps = new Date(y, m - 2, closingDay + 1);
    const pe = new Date(y, m - 1, closingDay);
    periodStart = `${ps.getMonth() + 1}/${ps.getDate()}`;
    periodEnd = `${pe.getMonth() + 1}/${pe.getDate()}`;
  } else {
    // 当月の締め日+1〜翌月の締め日
    const ps = new Date(y, m - 1, closingDay + 1);
    const pe = new Date(y, m, closingDay);
    periodStart = `${ps.getMonth() + 1}/${ps.getDate()}`;
    periodEnd = `${pe.getMonth() + 1}/${pe.getDate()}`;
  }
  return `${periodStart}〜${periodEnd}利用分`;
}

function isNonBusinessDay(date) {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return true;
  return JP_HOLIDAYS.has(date.toISOString().slice(0, 10));
}

// adjustActualDay: "none"=そのまま | "before"=前営業日 | "after"=次営業日（土日祝すべてスキップ）
function adjustActualDay(year, month, baseDay, adjust) {
  if (adjust === "none") return baseDay;
  const daysInMon = new Date(year, month + 1, 0).getDate();
  let date = new Date(year, month, Math.min(baseDay, daysInMon));
  const step = adjust === "before" ? -1 : 1;
  while (isNonBusinessDay(date)) {
    date.setDate(date.getDate() + step);
  }
  return date.getDate();
}

// Default recurring events — now include weekendAdjust field
const DEFAULT_EVENTS = [
  { id: 1, label: "給料日", type: "salary", day: 25, amount: 280000, memo: "", weekendAdjust: "none" },
  { id: 2, label: "クレカ支払い", type: "credit", day: 10, amount: 0, memo: "引き落とし", weekendAdjust: "after" },
  { id: 3, label: "ローン返済（既存）", type: "loan", day: 27, amount: 30000, memo: "", weekendAdjust: "before" },
  { id: 4, label: "ローン返済（新規）", type: "loan", day: 27, amount: 70000, memo: "", weekendAdjust: "before" },
  { id: 5, label: "共同費（光熱費・食費）", type: "utility", day: 1, amount: 40000, memo: "友人と折半", weekendAdjust: "none" },
  { id: 6, label: "家賃", type: "rent", day: 1, amount: 20000, memo: "", weekendAdjust: "none" },
];

const DEFAULT_DATA = {
  tasks: [
    { id: 1, text: "スーパーで買い物", category: "買い物", done: false, due: today() },
    { id: 2, text: "部屋の掃除", category: "家事", done: false, due: today() },
  ],
  transactions: [],
  budget: FIXED_BUDGET,
  loanPaidMonths: 0,
  recurringEvents: DEFAULT_EVENTS,
};

const inp = {
  background: "#12121a", border: "1px solid #2a2a38", borderRadius: 8,
  padding: "10px 14px", color: "#e8e4dc", fontSize: 14,
  fontFamily: "'Noto Sans JP', sans-serif", outline: "none", width: "100%", boxSizing: "border-box",
};

export default function App() {
  const [tab, setTab] = useState("calendar");
  const [tasks, setTasks] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [budget, setBudget] = useState(FIXED_BUDGET);
  const [loanPaidMonths, setLoanPaidMonths] = useState(0);
  const [recurringEvents, setRecurringEvents] = useState(DEFAULT_EVENTS);
  const [monthlySalaries, setMonthlySalaries] = useState({});
  const [showSalaryInput, setShowSalaryInput] = useState(false);
  const [salaryDraft, setSalaryDraft] = useState("");
  // クレカ管理
  const [creditCards, setCreditCards] = useState([
    { id: 1, name: "カード①", closingDay: 15, payDay: 10, color: "#6080e0" },
  ]);
  const [showCardModal, setShowCardModal] = useState(false);
  const [editingCard, setEditingCard] = useState(null);
  const [cardDraft, setCardDraft] = useState({ name: "", closingDay: 15, payDay: 10, color: "#6080e0" });
  const [loadState, setLoadState] = useState("loading");
  const [saveState, setSaveState] = useState("idle");

  // Diet state
  const [dietRefresh, setDietRefresh] = useState(0); // force re-render for manual checks
  // 筋トレスケジュール（週3回ローテーション）
  const WORKOUT_SCHEDULE = [
    { day: 0, name: "休息日", exercises: [], rest: true }, // 日
    { day: 1, name: "腹筋・背筋の日", exercises: [
      { name: "腹筋（クランチ）", sets: 3, reps: 15, rest: "30秒休憩", tip: "ゆっくり上げてゆっくり下げる" },
      { name: "背筋（バックエクステンション）", sets: 3, reps: 15, rest: "30秒休憩", tip: "床に伏せて上体を持ち上げる" },
      { name: "プランク", sets: 3, reps: "30秒", rest: "30秒休憩", tip: "体をまっすぐ保つ" },
    ]},
    { day: 2, name: "休息日", exercises: [], rest: true }, // 火
    { day: 3, name: "スクワットの日", exercises: [
      { name: "スクワット", sets: 3, reps: 20, rest: "45秒休憩", tip: "膝がつま先より前に出ないように" },
      { name: "ランジ", sets: 3, reps: 12, rest: "45秒休憩", tip: "左右交互に。バランスに注意" },
      { name: "カーフレイズ", sets: 3, reps: 20, rest: "30秒休憩", tip: "かかとを上げ下げするだけ" },
    ]},
    { day: 4, name: "休息日", exercises: [], rest: true }, // 木
    { day: 5, name: "腕立て・上半身の日", exercises: [
      { name: "腕立て伏せ", sets: 3, reps: 10, rest: "45秒休憩", tip: "きつければ膝をついてOK" },
      { name: "ダイヤモンドプッシュアップ", sets: 2, reps: 8, rest: "45秒休憩", tip: "手を菱形にして二の腕を鍛える" },
      { name: "腹筋（レッグレイズ）", sets: 3, reps: 12, rest: "30秒休憩", tip: "足をゆっくり上げ下げする" },
    ]},
    { day: 6, name: "ウォーキング強化日", exercises: [
      { name: "ウォーキング", sets: 1, reps: "40分以上", rest: "", tip: "少し速めのペースで。8,000歩目標" },
      { name: "ストレッチ", sets: 1, reps: "10分", rest: "", tip: "全身をほぐして翌週に備える" },
    ]},
  ];
  const [weightLog, setWeightLog] = useState([]); // [{date, weight}]
  const [mealLog, setMealLog] = useState([]);     // 後方互換のため残す
  const [nutritionLog, setNutritionLog] = useState([]); // [{date, kcal, protein, fat, carbs, sugar, fiber, salt}]
  const [exerciseLog, setExerciseLog] = useState([]); // [{date, steps, burnedKcal, speed, duration}]
  const [newWeight, setNewWeight] = useState("");
  const [newNutrition, setNewNutrition] = useState({ date: today(), kcal: "", protein: "", fat: "", carbs: "", sugar: "", fiber: "", salt: "" });
  const [newExercise, setNewExercise] = useState({ steps: "", burnedKcal: "", speed: "", duration: "", date: today() });
  const [nutritionViewDate, setNutritionViewDate] = useState(today());
  const TARGET_WEIGHT = 70;
  const START_WEIGHT = 87.3;
  const PLAN_MONTHS = 12;
  const MONTHLY_GOAL = (START_WEIGHT - TARGET_WEIGHT) / PLAN_MONTHS; // 約1.44kg/月
  const DAILY_KCAL_TARGET = 1900;
  const PLAN_START = "2026-05-01"; // プラン開始日

  // Calendar state
  const now = new Date();
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth()); // 0-indexed
  const [showEventModal, setShowEventModal] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [newEvent, setNewEvent] = useState({ label: "", type: "other", day: 1, amount: "", memo: "", weekendAdjust: "before" });
  const [selectedDay, setSelectedDay] = useState(null);

  // Task/money form state
  const [newTask, setNewTask] = useState({ text: "", category: "その他", due: today() });
  const [newTx, setNewTx] = useState({ type: "expense", label: "", amount: "", date: today(), category: "食費", payMethod: "cash", cardId: null });
  const [moneyViewMode, setMoneyViewMode] = useState("month"); // "month" | "day"
  const [moneyViewDate, setMoneyViewDate] = useState(today());
  const [moneyViewMonth, setMoneyViewMonth] = useState(today().slice(0, 7));

  const isSyncing = useRef(false);

  useEffect(() => {
    const dbRef = ref(db, "life-manager-data");
    get(dbRef).then(snap => {
      const data = snap.val();
      if (data) {
        setTasks(data.tasks ?? DEFAULT_DATA.tasks);
        setTransactions(data.transactions ?? []);
        setBudget(data.budget ?? FIXED_BUDGET);
        setLoanPaidMonths(data.loanPaidMonths ?? 0);
        setRecurringEvents(data.recurringEvents ?? DEFAULT_EVENTS);
        setMonthlySalaries(data.monthlySalaries ?? {});
        setCreditCards(data.creditCards ?? [{ id: 1, name: "カード①", closingDay: 15, payDay: 10, color: "#6080e0" }]);
        setWeightLog(data.weightLog ?? []);
        setMealLog(data.mealLog ?? []);
        setExerciseLog(data.exerciseLog ?? []);
        setNutritionLog(data.nutritionLog ?? []);
      } else {
        setTasks(DEFAULT_DATA.tasks);
        setRecurringEvents(DEFAULT_EVENTS);
      }
      setLoadState("ready");
      onValue(dbRef, snap => {
        if (isSyncing.current) return;
        const d = snap.val();
        if (d) {
          setTasks(d.tasks ?? []);
          setTransactions(d.transactions ?? []);
          setBudget(d.budget ?? FIXED_BUDGET);
          setLoanPaidMonths(d.loanPaidMonths ?? 0);
          setRecurringEvents(d.recurringEvents ?? DEFAULT_EVENTS);
          setMonthlySalaries(d.monthlySalaries ?? {});
          setCreditCards(d.creditCards ?? []);
        }
      });
    }).catch(() => {
      setTasks(DEFAULT_DATA.tasks);
      setRecurringEvents(DEFAULT_EVENTS);
      setLoadState("ready");
    });
  }, []);

  const saveAll = useCallback((t, tx, b, lpm, re, ms, cc, wl, ml, el, nl) => {
    setSaveState("saving");
    const data = { tasks: t, transactions: tx, budget: b, loanPaidMonths: lpm, recurringEvents: re, monthlySalaries: ms, creditCards: cc, weightLog: wl, mealLog: ml, exerciseLog: el, nutritionLog: nl };
    isSyncing.current = true;
    set(ref(db, "life-manager-data"), data)
      .then(() => { setSaveState("saved"); setTimeout(() => setSaveState("idle"), 1800); })
      .catch(err => { console.error("Firebase error:", err); setSaveState("error"); setTimeout(() => setSaveState("idle"), 3000); })
      .finally(() => { setTimeout(() => { isSyncing.current = false; }, 500); });
  }, []);

  const updateTasks = (next) => { setTasks(next); saveAll(next, transactions, budget, loanPaidMonths, recurringEvents, monthlySalaries, creditCards, weightLog, mealLog, exerciseLog, nutritionLog); };
  const updateTxs = (next) => { setTransactions(next); saveAll(tasks, next, budget, loanPaidMonths, recurringEvents, monthlySalaries, creditCards, weightLog, mealLog, exerciseLog, nutritionLog); };
  const updateLoanPaid = (next) => { setLoanPaidMonths(next); saveAll(tasks, transactions, budget, next, recurringEvents, monthlySalaries, creditCards, weightLog, mealLog, exerciseLog); };
  const updateEvents = (next) => { setRecurringEvents(next); saveAll(tasks, transactions, budget, loanPaidMonths, next, monthlySalaries, creditCards, weightLog, mealLog, exerciseLog); };
  const updateMonthlySalary = (key, amount) => {
    const next = { ...monthlySalaries, [key]: amount };
    setMonthlySalaries(next);
    saveAll(tasks, transactions, budget, loanPaidMonths, recurringEvents, next, creditCards, weightLog, mealLog, exerciseLog);
  };
  const updateCreditCards = (next) => { setCreditCards(next); saveAll(tasks, transactions, budget, loanPaidMonths, recurringEvents, monthlySalaries, next, weightLog, mealLog, exerciseLog); };
  const updateWeightLog = (next) => { setWeightLog(next); saveAll(tasks, transactions, budget, loanPaidMonths, recurringEvents, monthlySalaries, creditCards, next, mealLog, exerciseLog, nutritionLog); };
  const updateMealLog = (next) => { setMealLog(next); saveAll(tasks, transactions, budget, loanPaidMonths, recurringEvents, monthlySalaries, creditCards, weightLog, next, exerciseLog, nutritionLog); };
  const updateExerciseLog = (next) => { setExerciseLog(next); saveAll(tasks, transactions, budget, loanPaidMonths, recurringEvents, monthlySalaries, creditCards, weightLog, mealLog, next, nutritionLog); };
  const updateNutritionLog = (next) => { setNutritionLog(next); saveAll(tasks, transactions, budget, loanPaidMonths, recurringEvents, monthlySalaries, creditCards, weightLog, mealLog, exerciseLog, next); };
  const saveCard = () => {
    if (!cardDraft.name.trim()) return;
    if (editingCard !== null) {
      updateCreditCards(creditCards.map(c => c.id === editingCard ? { ...cardDraft, id: editingCard } : c));
    } else {
      updateCreditCards([...creditCards, { ...cardDraft, id: Date.now(), closingDay: Number(cardDraft.closingDay), payDay: Number(cardDraft.payDay) }]);
    }
    setShowCardModal(false);
    setEditingCard(null);
    setCardDraft({ name: "", closingDay: 15, payDay: 10, color: "#6080e0" });
  };
  const deleteCard = (id) => updateCreditCards(creditCards.filter(c => c.id !== id));

  const addTask = () => {
    if (!newTask.text.trim()) return;
    updateTasks([...tasks, { ...newTask, id: Date.now(), done: false }]);
    setNewTask({ text: "", category: "その他", due: today() });
  };
  const toggleTask = (id) => updateTasks(tasks.map(t => t.id === id ? { ...t, done: !t.done } : t));
  const deleteTask = (id) => updateTasks(tasks.filter(t => t.id !== id));

  const addTx = () => {
    if (!newTx.label.trim() || !newTx.amount) return;
    updateTxs([...transactions, { ...newTx, id: Date.now(), amount: Number(newTx.amount) }]);
    setNewTx({ type: "expense", label: "", amount: "", date: today(), category: "食費", payMethod: "cash", cardId: null });
  };
  const deleteTx = (id) => updateTxs(transactions.filter(t => t.id !== id));

  const saveEvent = () => {
    if (!newEvent.label.trim() || !newEvent.day) return;
    if (editingEvent !== null) {
      updateEvents(recurringEvents.map(e => e.id === editingEvent ? { ...newEvent, id: editingEvent } : e));
    } else {
      updateEvents([...recurringEvents, { ...newEvent, id: Date.now(), amount: Number(newEvent.amount) || 0 }]);
    }
    setShowEventModal(false);
    setEditingEvent(null);
    setNewEvent({ label: "", type: "other", day: 1, amount: "", memo: "", weekendAdjust: "before" });
  };
  const deleteEvent = (id) => updateEvents(recurringEvents.filter(e => e.id !== id));
  const openEditEvent = (ev) => {
    setNewEvent({ ...ev, amount: ev.amount || "", weekendAdjust: ev.weekendAdjust ?? "before" });
    setEditingEvent(ev.id);
    setShowEventModal(true);
  };

  // Calendar helpers
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDayOfWeek = new Date(calYear, calMonth, 1).getDay();
  const todayStr = today();
  const eventsOnDay = (d) => recurringEvents.filter(e => adjustActualDay(calYear, calMonth, e.day, e.weekendAdjust ?? "none") === d);
  const selectedDayEvents = selectedDay ? eventsOnDay(selectedDay) : [];
  const calMonthKey = `${calYear}-${String(calMonth + 1).padStart(2, "0")}`;
  const actualSalary = monthlySalaries[calMonthKey];
  const defaultSalary = recurringEvents.filter(e => e.type === "salary").reduce((s, e) => s + (e.amount || 0), 0);
  const displaySalary = actualSalary ?? defaultSalary;

  // Monthly summary from events
  const monthlyIncome = displaySalary;
  const monthlyOut = recurringEvents.filter(e => e.type !== "salary").reduce((s, e) => s + (e.amount || 0), 0);

  // Loan
  const schedule = calcRepaymentSchedule(LOAN_INFO.principal, LOAN_INFO.monthlyPayment, LOAN_INFO.annualRate, LOAN_INFO.startDate);
  const totalMonths = schedule.length;
  const remainingMonths = Math.max(0, totalMonths - loanPaidMonths);
  const currentBalance = loanPaidMonths > 0 ? schedule[Math.min(loanPaidMonths - 1, schedule.length - 1)].balance : LOAN_INFO.principal;
  const totalInterest = schedule.reduce((s, m) => s + m.interest, 0);
  const paidInterest = schedule.slice(0, loanPaidMonths).reduce((s, m) => s + m.interest, 0);
  const progressPct = Math.min(100, (loanPaidMonths / totalMonths) * 100);
  const completionDate = loanPaidMonths >= totalMonths ? "完済済み！" : (() => { const [y, m] = schedule[totalMonths - 1].date.split("-"); return `${y}年${parseInt(m)}月`; })();

  const income = transactions.filter(t => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const expense = transactions.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  // カレンダーで入力した給料を収入に加算
  const currentMonthKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  const salaryIncome = monthlySalaries[currentMonthKey] ?? recurringEvents.filter(e => e.type === "salary").reduce((s, e) => s + (e.amount || 0), 0);
  const totalIncome = income + salaryIncome;
  const balance = totalIncome - expense;
  const pending = tasks.filter(t => !t.done).length;
  const done = tasks.filter(t => t.done).length;

  const SaveIndicator = () => {
    const map = { saving: ["☁ 同期中…", "#7a7a8a"], saved: ["☁ 同期済み ✓", "#50c878"], error: ["⚠ 同期失敗", "#e05050"] };
    if (!map[saveState]) return null;
    const [text, color] = map[saveState];
    return <span style={{ fontSize: 11, color, marginLeft: "auto" }}>{text}</span>;
  };

  if (loadState === "loading") return (
    <div style={{ minHeight: "100vh", background: "#0f0f13", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
      <div style={{ width: 32, height: 32, borderRadius: "50%", border: "3px solid #2a2a38", borderTopColor: "#f0c060", animation: "spin 0.8s linear infinite" }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
      <span style={{ color: "#5a5a6a", fontSize: 13 }}>データを読み込み中…</span>
    </div>
  );

  const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  return (
    <div style={{ minHeight: "100vh", background: "#0f0f13", fontFamily: "'Noto Sans JP','Hiragino Kaku Gothic ProN',sans-serif", color: "#e8e4dc" }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>

      {/* Card Modal */}
      {showCardModal && (
        <div style={{ position: "fixed", inset: 0, background: "#000000cc", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#1a1a24", borderRadius: 16, padding: 24, width: "100%", maxWidth: 400, border: "1px solid #2a2a38", animation: "fadeIn 0.2s ease" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>💳 {editingCard ? "カードを編集" : "カードを追加"}</div>
              <button onClick={() => { setShowCardModal(false); setEditingCard(null); }} style={{ marginLeft: "auto", background: "none", border: "none", color: "#5a5a6a", fontSize: 20, cursor: "pointer" }}>×</button>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: "#7a7a8a", display: "block", marginBottom: 6 }}>カード名</label>
              <input value={cardDraft.name} onChange={e => setCardDraft({ ...cardDraft, name: e.target.value })} placeholder="例: 楽天カード、PayPayカード" style={inp} />
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: "#7a7a8a", display: "block", marginBottom: 6 }}>締め日</label>
                <input type="number" min="1" max="31" value={cardDraft.closingDay} onChange={e => setCardDraft({ ...cardDraft, closingDay: Number(e.target.value) })} style={inp} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: "#7a7a8a", display: "block", marginBottom: 6 }}>支払日</label>
                <input type="number" min="1" max="31" value={cardDraft.payDay} onChange={e => setCardDraft({ ...cardDraft, payDay: Number(e.target.value) })} style={inp} />
              </div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, color: "#7a7a8a", display: "block", marginBottom: 8 }}>カラー</label>
              <div style={{ display: "flex", gap: 8 }}>
                {["#6080e0","#e07060","#50c878","#f0c060","#a060f0","#60c0d0"].map(c => (
                  <button key={c} onClick={() => setCardDraft({ ...cardDraft, color: c })} style={{ width: 28, height: 28, borderRadius: "50%", background: c, border: cardDraft.color === c ? "3px solid #fff" : "3px solid transparent", cursor: "pointer" }} />
                ))}
              </div>
            </div>
            <div style={{ fontSize: 12, color: "#5a5a6a", background: "#12121a", borderRadius: 8, padding: "10px 12px", marginBottom: 16 }}>
              例: 締め日{cardDraft.closingDay}日 → {cardDraft.closingDay}日以前の利用分は翌月{cardDraft.payDay}日払い
            </div>
            <button onClick={saveCard} style={{ width: "100%", padding: 12, borderRadius: 10, border: "none", background: "linear-gradient(135deg,#f0c060,#e07030)", color: "#0f0f13", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
              {editingCard ? "保存する" : "追加する"}
            </button>
          </div>
        </div>
      )}

      {/* Event Modal */}
      {showEventModal && (
        <div style={{ position: "fixed", inset: 0, background: "#000000cc", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#1a1a24", borderRadius: 16, padding: 24, width: "100%", maxWidth: 400, border: "1px solid #2a2a38", animation: "fadeIn 0.2s ease" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{editingEvent ? "イベントを編集" : "イベントを追加"}</div>
              <button onClick={() => { setShowEventModal(false); setEditingEvent(null); setNewEvent({ label: "", type: "other", day: 1, amount: "", memo: "" }); }} style={{ marginLeft: "auto", background: "none", border: "none", color: "#5a5a6a", fontSize: 20, cursor: "pointer" }}>×</button>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: "#7a7a8a", display: "block", marginBottom: 6 }}>イベント名</label>
              <input value={newEvent.label} onChange={e => setNewEvent({ ...newEvent, label: e.target.value })} placeholder="例: 給料日、クレカ引き落とし" style={inp} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: "#7a7a8a", display: "block", marginBottom: 6 }}>種類</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {EVENT_TYPES.map(et => (
                  <button key={et.key} onClick={() => setNewEvent({ ...newEvent, type: et.key })} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontFamily: "inherit", cursor: "pointer", border: newEvent.type === et.key ? "none" : "1px solid #2a2a38", background: newEvent.type === et.key ? et.color + "30" : "#12121a", color: newEvent.type === et.key ? et.color : "#5a5a6a", fontWeight: newEvent.type === et.key ? 700 : 400 }}>{et.icon} {et.label}</button>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: "#7a7a8a", display: "block", marginBottom: 6 }}>毎月何日</label>
                <input type="number" min="1" max="31" value={newEvent.day} onChange={e => setNewEvent({ ...newEvent, day: Number(e.target.value) })} style={inp} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: "#7a7a8a", display: "block", marginBottom: 6 }}>金額（円）</label>
                <input type="number" value={newEvent.amount} onChange={e => setNewEvent({ ...newEvent, amount: e.target.value })} placeholder="任意" style={inp} />
              </div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, color: "#7a7a8a", display: "block", marginBottom: 6 }}>メモ（任意）</label>
              <input value={newEvent.memo} onChange={e => setNewEvent({ ...newEvent, memo: e.target.value })} placeholder="例: 〇〇カード" style={inp} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, color: "#7a7a8a", display: "block", marginBottom: 8 }}>土日の場合</label>
              <div style={{ display: "flex", gap: 6 }}>
                {[["before", "前の平日"], ["after", "次の平日"], ["none", "そのまま"]].map(([key, label]) => (
                  <button key={key} onClick={() => setNewEvent({ ...newEvent, weekendAdjust: key })} style={{ flex: 1, padding: "8px 4px", borderRadius: 8, fontSize: 12, fontFamily: "inherit", cursor: "pointer", fontWeight: newEvent.weekendAdjust === key ? 700 : 400, border: newEvent.weekendAdjust === key ? "none" : "1px solid #2a2a38", background: newEvent.weekendAdjust === key ? "linear-gradient(135deg,#f0c060,#e07030)" : "#12121a", color: newEvent.weekendAdjust === key ? "#0f0f13" : "#7a7a8a" }}>{label}</button>
                ))}
              </div>
            </div>
            <button onClick={saveEvent} style={{ width: "100%", padding: "12px", borderRadius: 10, border: "none", background: "linear-gradient(135deg,#f0c060,#e07030)", color: "#0f0f13", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
              {editingEvent ? "保存する" : "追加する"}
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ background: "linear-gradient(135deg,#1a1a24,#12121a)", borderBottom: "1px solid #2a2a38", padding: "20px 24px 0", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ maxWidth: 680, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "linear-gradient(135deg,#f0c060,#e07030)", boxShadow: "0 0 12px #f0c06080" }} />
            <span style={{ fontSize: 11, letterSpacing: "0.15em", color: "#7a7a8a", textTransform: "uppercase" }}>My Life Manager</span>
            <SaveIndicator />
          </div>
          <div style={{ display: "flex", gap: 0, overflowX: "auto" }}>
            {[
              { key: "calendar", label: "カレンダー", badge: null },
              { key: "money", label: "お金", badge: null },
              { key: "budget", label: "予算", badge: null },
              { key: "loan", label: "返済", badge: null },
              { key: "diet", label: "ダイエット", badge: null },
            ].map(({ key, label, badge }) => (
              <button key={key} onClick={() => setTab(key)} style={{ background: "none", border: "none", padding: "12px 16px", fontSize: 13, fontWeight: 500, cursor: "pointer", color: tab === key ? "#f0c060" : "#5a5a6a", borderBottom: tab === key ? "2px solid #f0c060" : "2px solid transparent", transition: "all 0.2s", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                {label}
                {badge !== null && badge > 0 && <span style={{ background: "#e07030", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, padding: "1px 6px" }}>{badge}</span>}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 680, margin: "0 auto", padding: "24px 16px 48px" }}>

        {/* ===== CALENDAR ===== */}
        {tab === "calendar" && (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            {/* Salary input card */}
            <div style={{ background: "#1a2418", borderRadius: 12, padding: "16px", border: "1px solid #2a3828", marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: showSalaryInput ? 12 : 0 }}>
                <div>
                  <div style={{ fontSize: 11, color: "#4a7a5a", marginBottom: 3 }}>
                    {calYear}年{calMonth + 1}月の給料
                    {actualSalary && <span style={{ marginLeft: 6, fontSize: 10, color: "#50c878", background: "#50c87820", borderRadius: 4, padding: "1px 5px" }}>入力済み</span>}
                    {!actualSalary && <span style={{ marginLeft: 6, fontSize: 10, color: "#5a7a5a", background: "#2a3a2a", borderRadius: 4, padding: "1px 5px" }}>予定額</span>}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "#50c878" }}>{formatMoney(displaySalary)}</div>
                </div>
                <button
                  onClick={() => { setShowSalaryInput(!showSalaryInput); setSalaryDraft(actualSalary ? String(actualSalary) : ""); }}
                  style={{ background: showSalaryInput ? "#2a2a38" : "linear-gradient(135deg,#50c878,#30a858)", border: "none", borderRadius: 8, padding: "8px 14px", color: showSalaryInput ? "#7a7a8a" : "#0f0f13", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
                >
                  {showSalaryInput ? "キャンセル" : "給料を入力"}
                </button>
              </div>
              {showSalaryInput && (
                <div style={{ display: "flex", gap: 8, animation: "fadeIn 0.15s ease" }}>
                  <input
                    type="number"
                    value={salaryDraft}
                    onChange={e => setSalaryDraft(e.target.value)}
                    placeholder={`例: ${defaultSalary}`}
                    style={{ flex: 1, background: "#12121a", border: "1px solid #2a3828", borderRadius: 8, padding: "10px 12px", color: "#e8e4dc", fontSize: 14, fontFamily: "inherit", outline: "none" }}
                    onKeyDown={e => {
                      if (e.key === "Enter" && salaryDraft) {
                        updateMonthlySalary(calMonthKey, Number(salaryDraft));
                        setShowSalaryInput(false);
                      }
                    }}
                  />
                  <button
                    onClick={() => { if (salaryDraft) { updateMonthlySalary(calMonthKey, Number(salaryDraft)); setShowSalaryInput(false); } }}
                    style={{ background: "linear-gradient(135deg,#f0c060,#e07030)", border: "none", borderRadius: 8, padding: "10px 18px", color: "#0f0f13", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}
                  >確定</button>
                  {actualSalary && (
                    <button
                      onClick={() => { const next = { ...monthlySalaries }; delete next[calMonthKey]; setMonthlySalaries(next); saveAll(tasks, transactions, budget, loanPaidMonths, recurringEvents, next, creditCards, weightLog, mealLog, exerciseLog); setShowSalaryInput(false); }}
                      style={{ background: "none", border: "1px solid #3a2020", borderRadius: 8, padding: "10px 12px", color: "#7a4a4a", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
                    >リセット</button>
                  )}
                </div>
              )}
            </div>

            {/* Monthly summary */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
              <div style={{ background: "#1a2418", borderRadius: 12, padding: "14px 16px", border: "1px solid #2a3828" }}>
                <div style={{ fontSize: 11, color: "#4a7a5a", marginBottom: 4 }}>手取り収入</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#50c878" }}>{formatMoney(monthlyIncome)}</div>
              </div>
              <div style={{ background: "#241a14", borderRadius: 12, padding: "14px 16px", border: "1px solid #382a20" }}>
                <div style={{ fontSize: 11, color: "#7a5a4a", marginBottom: 4 }}>月固定支出合計</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#e07030" }}>{formatMoney(monthlyOut)}</div>
              </div>
            </div>

            {/* Calendar nav */}
            <div style={{ background: "#1a1a24", borderRadius: 12, border: "1px solid #2a2a38", overflow: "hidden", marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid #2a2a38" }}>
                <button onClick={() => { const d = new Date(calYear, calMonth - 1); setCalYear(d.getFullYear()); setCalMonth(d.getMonth()); setSelectedDay(null); }} style={{ background: "none", border: "none", color: "#7a7a8a", fontSize: 18, cursor: "pointer", padding: "0 8px" }}>‹</button>
                <div style={{ flex: 1, textAlign: "center", fontSize: 15, fontWeight: 700 }}>{calYear}年{calMonth + 1}月</div>
                <button onClick={() => { const d = new Date(calYear, calMonth + 1); setCalYear(d.getFullYear()); setCalMonth(d.getMonth()); setSelectedDay(null); }} style={{ background: "none", border: "none", color: "#7a7a8a", fontSize: 18, cursor: "pointer", padding: "0 8px" }}>›</button>
              </div>

              {/* Weekday headers */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", background: "#12121a" }}>
                {WEEKDAYS.map((w, i) => (
                  <div key={w} style={{ textAlign: "center", padding: "8px 2px", fontSize: 11, color: i === 0 ? "#e05050" : i === 6 ? "#5080e0" : "#5a5a6a", fontWeight: 600 }}>{w}</div>
                ))}
              </div>

              {/* Days grid */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 1, background: "#1e1e2a", padding: 1 }}>
                {Array.from({ length: firstDayOfWeek }).map((_, i) => (
                  <div key={`empty-${i}`} style={{ background: "#12121a", minHeight: 56 }} />
                ))}
                {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => {
                  const dayEvents = eventsOnDay(d);
                  const isToday = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}` === todayStr;
                  const isSelected = selectedDay === d;
                  const dow = (firstDayOfWeek + d - 1) % 7;
                  return (
                    <div key={d} onClick={() => setSelectedDay(isSelected ? null : d)} style={{ background: isSelected ? "#1e1e34" : "#12121a", minHeight: 56, padding: "6px 4px", cursor: "pointer", border: isSelected ? "1px solid #4040a0" : "1px solid transparent", position: "relative", transition: "background 0.15s" }}>
                      <div style={{ fontSize: 12, fontWeight: isToday ? 700 : 400, color: isToday ? "#f0c060" : dow === 0 ? "#e05050" : dow === 6 ? "#5080e0" : "#9a9aaa", background: isToday ? "#f0c06020" : "none", borderRadius: 4, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 2 }}>{d}</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                        {dayEvents.slice(0, 2).map(ev => {
                          const et = EVENT_TYPES.find(t => t.key === ev.type) || EVENT_TYPES[4];
                          return (
                            <div key={ev.id} style={{ fontSize: 9, background: et.color + "25", color: et.color, borderRadius: 3, padding: "1px 3px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                              {et.icon}{ev.label}
                            </div>
                          );
                        })}
                        {dayEvents.length > 2 && <div style={{ fontSize: 9, color: "#5a5a6a" }}>+{dayEvents.length - 2}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Selected day detail */}
            {selectedDay && (
              <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: "1px solid #2a2a38", marginBottom: 20, animation: "fadeIn 0.2s ease" }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: "#f0c060" }}>{calMonth + 1}月{selectedDay}日のイベント</div>
                {selectedDayEvents.length === 0 ? (
                  <div style={{ fontSize: 13, color: "#4a4a5a", textAlign: "center", padding: "12px 0" }}>イベントなし</div>
                ) : (
                  selectedDayEvents.map(ev => {
                    const et = EVENT_TYPES.find(t => t.key === ev.type) || EVENT_TYPES[4];
                    return (
                      <div key={ev.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid #1e1e2a" }}>
                        <div style={{ width: 32, height: 32, borderRadius: 8, background: et.color + "20", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>{et.icon}</div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 14, fontWeight: 500 }}>{ev.label}</div>
                          <div style={{ fontSize: 11, color: "#5a5a6a", marginTop: 2 }}>{et.label}{ev.memo ? ` · ${ev.memo}` : ""}</div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          {ev.amount > 0 && <div style={{ fontSize: 14, fontWeight: 700, color: ev.type === "salary" ? "#50c878" : "#e07030" }}>{ev.type === "salary" ? "+" : "-"}{formatMoney(ev.amount)}</div>}
                          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                            <button onClick={() => openEditEvent(ev)} style={{ background: "none", border: "1px solid #2a2a38", borderRadius: 6, padding: "2px 8px", color: "#7a7a8a", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>編集</button>
                            <button onClick={() => deleteEvent(ev.id)} style={{ background: "none", border: "1px solid #3a2020", borderRadius: 6, padding: "2px 8px", color: "#7a4a4a", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>削除</button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {/* Event list */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase" }}>毎月の固定イベント一覧</div>
              <button onClick={() => { setShowEventModal(true); setEditingEvent(null); setNewEvent({ label: "", type: "other", day: 1, amount: "", memo: "" }); }} style={{ background: "linear-gradient(135deg,#f0c060,#e07030)", border: "none", borderRadius: 8, padding: "6px 16px", color: "#0f0f13", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>＋ 追加</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[...recurringEvents].sort((a, b) => a.day - b.day).map(ev => {
                const et = EVENT_TYPES.find(t => t.key === ev.type) || EVENT_TYPES[4];
                const actualDay = adjustActualDay(calYear, calMonth, ev.day, ev.weekendAdjust ?? "none");
                const adjusted = actualDay !== ev.day;
                const adjLabel = { before: "土日祝→前営業日", after: "土日祝→翌営業日", none: "" }[ev.weekendAdjust ?? "none"];
                return (
                  <div key={ev.id} style={{ background: "#1a1a24", borderRadius: 10, padding: "12px 16px", border: "1px solid #2a2a38", display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 10, background: et.color + "20", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <span style={{ fontSize: 14 }}>{et.icon}</span>
                      <span style={{ fontSize: 9, color: et.color, fontWeight: 700 }}>{actualDay}日</span>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{ev.label}</div>
                      <div style={{ fontSize: 11, color: "#5a5a6a", marginTop: 1 }}>
                        毎月{ev.day}日基準
                        {adjusted && <span style={{ color: "#f0a030", marginLeft: 4 }}>→ {calMonth + 1}月は{actualDay}日</span>}
                        {ev.memo ? ` · ${ev.memo}` : ""}
                      </div>
                      {adjLabel && <div style={{ fontSize: 10, color: "#5a5a6a", marginTop: 1 }}>⚙ {adjLabel}</div>}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {ev.amount > 0 && <div style={{ fontSize: 14, fontWeight: 700, color: ev.type === "salary" ? "#50c878" : "#e07030" }}>{ev.type === "salary" ? "+" : "-"}{formatMoney(ev.amount)}</div>}
                      <div style={{ display: "flex", gap: 6, marginTop: 4, justifyContent: "flex-end" }}>
                        <button onClick={() => openEditEvent(ev)} style={{ background: "none", border: "1px solid #2a2a38", borderRadius: 6, padding: "2px 8px", color: "#7a7a8a", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>編集</button>
                        <button onClick={() => deleteEvent(ev.id)} style={{ background: "none", border: "1px solid #3a2020", borderRadius: 6, padding: "2px 8px", color: "#7a4a4a", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>削除</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ===== MONEY ===== */}
        {tab === "money" && (
          <div>
            {/* 表示切替 */}
            <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
              <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: "1px solid #2a2a38" }}>
                {[["month","月別"],["day","日別"]].map(([mode, label]) => (
                  <button key={mode} onClick={() => setMoneyViewMode(mode)}
                    style={{ padding: "8px 16px", fontSize: 13, fontFamily: "inherit", cursor: "pointer", fontWeight: moneyViewMode === mode ? 700 : 400, border: "none", background: moneyViewMode === mode ? "linear-gradient(135deg,#f0c060,#e07030)" : "#12121a", color: moneyViewMode === mode ? "#0f0f13" : "#5a5a6a" }}>
                    {label}
                  </button>
                ))}
              </div>
              {moneyViewMode === "month" ? (
                <input type="month" value={moneyViewMonth} onChange={e => setMoneyViewMonth(e.target.value)}
                  style={{ flex: 1, ...inp, padding: "8px 12px" }} />
              ) : (
                <input type="date" value={moneyViewDate} onChange={e => setMoneyViewDate(e.target.value)}
                  style={{ flex: 1, ...inp, padding: "8px 12px" }} />
              )}
            </div>
            {(() => {
              const filteredTxs = moneyViewMode === "month"
                ? transactions.filter(t => t.date.startsWith(moneyViewMonth))
                : transactions.filter(t => t.date === moneyViewDate);
              const filteredIncome = filteredTxs.filter(t => t.type === "income").reduce((s, t) => s + t.amount, 0);
              const filteredExpense = filteredTxs.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
              const filteredBalance = filteredIncome - filteredExpense;
              const periodLabel = moneyViewMode === "month" ? `${moneyViewMonth.replace("-","年")}月` : moneyViewDate;
              // 月表示の場合は給料も含める
              const currentMonthKey2 = moneyViewMonth;
              const salaryForPeriod = moneyViewMode === "month"
                ? (monthlySalaries[currentMonthKey2] ?? recurringEvents.filter(e => e.type === "salary").reduce((s, e) => s + (e.amount || 0), 0))
                : 0;
              const displayIncome = filteredIncome + salaryForPeriod;
              const displayBalance = displayIncome - filteredExpense;
              return (
                <div>
                  <div style={{ background: "linear-gradient(135deg,#1e1e2c,#16162040)", border: "1px solid #2a2a38", borderRadius: 16, padding: "24px 20px", marginBottom: 20, textAlign: "center" }}>
                    <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 8 }}>{periodLabel}の収支</div>
                    <div style={{ fontSize: 36, fontWeight: 700, color: displayBalance >= 0 ? "#50c878" : "#e05050" }}>{formatMoney(displayBalance)}</div>
                    <div style={{ display: "flex", justifyContent: "center", gap: 24, marginTop: 16 }}>
                      <div><div style={{ fontSize: 11, color: "#5a5a6a" }}>収入</div><div style={{ fontSize: 16, fontWeight: 600, color: "#50c878" }}>{formatMoney(displayIncome)}</div></div>
                      <div style={{ width: 1, background: "#2a2a38" }} />
                      <div><div style={{ fontSize: 11, color: "#5a5a6a" }}>支出</div><div style={{ fontSize: 16, fontWeight: 600, color: "#e07030" }}>{formatMoney(filteredExpense)}</div></div>
                    </div>
                  </div>
            {/* クレカ次月引き落とし予測 */}
            {creditCards.length > 0 && (() => {
              const nowD = new Date();
              const yr = nowD.getFullYear(), mo = nowD.getMonth(), dy = nowD.getDate();
              return (
                <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: "1px solid #2a2a38", marginBottom: 20 }}>
                  <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>次回引き落とし予測</div>
                  {creditCards.map(card => {
                    // 締め日を基準に「現在の締め期間」のクレカ支出を集計
                    // 前の締め日+1 〜 今の締め日 が現在の請求期間
                    const closingDay = card.closingDay;
                    let periodStart, periodEnd;
                    if (dy <= closingDay) {
                      // 前月の締め日+1 〜 今月の締め日
                      const prev = new Date(yr, mo - 1, closingDay + 1);
                      periodStart = prev.toISOString().slice(0,10);
                      periodEnd = new Date(yr, mo, closingDay).toISOString().slice(0,10);
                    } else {
                      // 今月の締め日+1 〜 来月の締め日
                      periodStart = new Date(yr, mo, closingDay + 1).toISOString().slice(0,10);
                      periodEnd = new Date(yr, mo + 1, closingDay).toISOString().slice(0,10);
                    }
                    const total = transactions
                      .filter(tx => tx.type === "expense" && tx.payMethod === "card" && tx.cardId === card.id && tx.date >= periodStart && tx.date <= periodEnd)
                      .reduce((s, tx) => s + tx.amount, 0);
                    // 正しい支払月: 締め日以内→翌月、超→翌々月
                    const payMonth = dy <= closingDay ? mo + 1 : mo + 2;
                    const payYear2 = payMonth > 12 ? yr + 1 : yr;
                    const payMonthDisplay = payMonth > 12 ? payMonth - 12 : payMonth;
                    const payStr = `${payYear2}年${payMonthDisplay}月${card.payDay}日`;
                    return (
                      <div key={card.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid #1e1e2a" }}>
                        <div style={{ width: 10, height: 10, borderRadius: "50%", background: card.color, flexShrink: 0 }} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{card.name}</div>
                          <div style={{ fontSize: 11, color: "#5a5a6a" }}>{payStr}払い · 集計: {periodStart.slice(5)}〜{periodEnd.slice(5)}</div>
                        </div>
                        <div style={{ fontSize: 16, fontWeight: 700, color: total > 0 ? "#e07030" : "#3a3a4a" }}>{formatMoney(total)}</div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* 予算 vs 実績 */}
            {(() => {
              const nowStr = today();
              const nowD = new Date();
              const daysInThisMonth = new Date(nowD.getFullYear(), nowD.getMonth() + 1, 0).getDate();
              const daysPassed = nowD.getDate();
              const monthProgress = daysPassed / daysInThisMonth;
              const budgetTotal = budget.salary;
              const expenseTotal = transactions.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
              const expectedByNow = Math.round(budgetTotal * monthProgress);
              const diff = expectedByNow - expenseTotal;
              const pct = budgetTotal > 0 ? Math.min(100, (expenseTotal / budgetTotal) * 100) : 0;
              const over = expenseTotal > expectedByNow;
              return (
                <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: `1px solid ${over ? "#3a2020" : "#2a2a38"}`, marginBottom: 20 }}>
                  <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>予算ペース確認（{daysPassed}日時点）</div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 11, color: "#5a5a6a" }}>この日までの想定支出</div>
                      <div style={{ fontSize: 16, fontWeight: 600, color: "#7a7a8a" }}>{formatMoney(expectedByNow)}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 11, color: "#5a5a6a" }}>実際の支出</div>
                      <div style={{ fontSize: 16, fontWeight: 600, color: over ? "#e05050" : "#50c878" }}>{formatMoney(expenseTotal)}</div>
                    </div>
                  </div>
                  <div style={{ background: "#12121a", borderRadius: 6, height: 8, marginBottom: 8 }}>
                    <div style={{ height: 8, borderRadius: 6, width: `${pct}%`, background: over ? "linear-gradient(90deg,#e05050,#c03030)" : "linear-gradient(90deg,#50c878,#30a858)", transition: "width 0.6s" }} />
                  </div>
                  <div style={{ fontSize: 12, color: over ? "#e05050" : "#50c878", fontWeight: 600, textAlign: "center" }}>
                    {over ? `⚠ ペースより ${formatMoney(expenseTotal - expectedByNow)} 超過` : `✓ ペースより ${formatMoney(diff)} 余裕あり`}
                  </div>
                </div>
              );
            })()}

            <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: "1px solid #2a2a38", marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>記録を追加</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                {["expense", "income"].map(type => (
                  <button key={type} onClick={() => setNewTx({ ...newTx, type })} style={{ flex: 1, padding: "8px", borderRadius: 8, fontSize: 13, fontFamily: "inherit", cursor: "pointer", fontWeight: 500, border: newTx.type === type ? "none" : "1px solid #2a2a38", background: newTx.type === type ? (type === "expense" ? "linear-gradient(135deg,#e07030,#c04020)" : "linear-gradient(135deg,#30a860,#1a8040)") : "#12121a", color: newTx.type === type ? "#fff" : "#5a5a6a" }}>{type === "expense" ? "支出" : "収入"}</button>
                ))}
              </div>
              <input value={newTx.label} onChange={e => setNewTx({ ...newTx, label: e.target.value })} placeholder="内容" style={{ ...inp, marginBottom: 8 }} />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input type="number" value={newTx.amount} onChange={e => setNewTx({ ...newTx, amount: e.target.value })} placeholder="金額 (円)" style={{ flex: 1, ...inp, minWidth: 100 }} />
                <select value={newTx.category} onChange={e => setNewTx({ ...newTx, category: e.target.value })} style={{ flex: 1, ...inp, minWidth: 90 }}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
                <input type="date" value={newTx.date} onChange={e => setNewTx({ ...newTx, date: e.target.value })} style={{ flex: 1, ...inp, minWidth: 130 }} />
                <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: "1px solid #2a2a38", flexShrink: 0 }}>
                  {[["cash","💴 現金"],["card","💳 クレカ"]].map(([key,label]) => (
                    <button key={key} onClick={() => setNewTx({ ...newTx, payMethod: key, cardId: key === "cash" ? null : (newTx.cardId ?? (creditCards[0]?.id ?? null)) })} style={{ padding: "8px 12px", fontSize: 12, fontFamily: "inherit", cursor: "pointer", fontWeight: newTx.payMethod === key ? 700 : 400, border: "none", background: newTx.payMethod === key ? (key === "card" ? "#3040a0" : "#2a3a2a") : "#12121a", color: newTx.payMethod === key ? (key === "card" ? "#a0c0ff" : "#50c878") : "#5a5a6a" }}>{label}</button>
                  ))}
                </div>
                {newTx.payMethod === "card" && creditCards.length > 0 && (
                  <select value={newTx.cardId ?? ""} onChange={e => setNewTx({ ...newTx, cardId: Number(e.target.value) })} style={{ flex: 1, ...inp, minWidth: 120, fontSize: 12 }}>
                    {creditCards.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                )}
                {newTx.payMethod === "card" && newTx.cardId && newTx.date && (() => {
                  const card = creditCards.find(c => c.id === newTx.cardId);
                  if (!card) return null;
                  const payStr = calcPaymentDate(card.closingDay, card.payDay, newTx.date);
                  const periodStr = calcBillingPeriod(card.closingDay, newTx.date);
                  return (
                    <div style={{ fontSize: 11, color: "#a0c0ff", background: "#1a2040", borderRadius: 6, padding: "6px 10px" }}>
                      <div>📅 {payStr}</div>
                      <div style={{ color: "#6080a0", marginTop: 2 }}>({periodStr})</div>
                    </div>
                  );
                })()}
                <button onClick={addTx} style={{ background: "linear-gradient(135deg,#f0c060,#e07030)", border: "none", borderRadius: 8, padding: "8px 20px", color: "#0f0f13", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>追加</button>
              </div>
            </div>
            {/* Credit card management */}
            <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: "1px solid #2a2a38", marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase" }}>クレカ管理</div>
                <button onClick={() => { setCardDraft({ name: "", closingDay: 15, payDay: 10, color: "#6080e0" }); setEditingCard(null); setShowCardModal(true); }} style={{ background: "linear-gradient(135deg,#f0c060,#e07030)", border: "none", borderRadius: 6, padding: "4px 12px", color: "#0f0f13", fontWeight: 700, fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>＋ 追加</button>
              </div>
              {creditCards.length === 0 && <div style={{ fontSize: 12, color: "#4a4a5a", textAlign: "center", padding: "8px 0" }}>カードが登録されていません</div>}
              {creditCards.map(card => (
                <div key={card.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid #1e1e2a" }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: card.color, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{card.name}</div>
                    <div style={{ fontSize: 11, color: "#5a5a6a" }}>毎月{card.closingDay}日締め → 翌月{card.payDay}日払い</div>
                  </div>
                  <button onClick={() => { setCardDraft({ ...card }); setEditingCard(card.id); setShowCardModal(true); }} style={{ background: "none", border: "1px solid #2a2a38", borderRadius: 6, padding: "2px 8px", color: "#7a7a8a", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>編集</button>
                  <button onClick={() => deleteCard(card.id)} style={{ background: "none", border: "1px solid #3a2020", borderRadius: 6, padding: "2px 8px", color: "#7a4a4a", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>削除</button>
                </div>
              ))}
            </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {filteredTxs.length === 0 && <div style={{ textAlign: "center", color: "#3a3a4a", padding: 32, fontSize: 14 }}>この期間の記録がありません</div>}
                    {[...filteredTxs].sort((a, b) => b.date.localeCompare(a.date)).map(tx => (
                      <div key={tx.id} style={{ background: "#1a1a24", borderRadius: 10, padding: "12px 16px", border: "1px solid #2a2a38", display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: tx.type === "income" ? "#50c878" : "#e07030" }} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 14, fontWeight: 500 }}>{tx.label}</div>
                          <div style={{ display: "flex", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 11, color: "#5a5a6a", background: "#22222e", borderRadius: 4, padding: "1px 6px" }}>{tx.category}</span>
                            {tx.payMethod === "card" ? (() => {
                              const card = creditCards.find(c => c.id === tx.cardId);
                              const payStr = card ? calcPaymentDate(card.closingDay, card.payDay, tx.date) : null;
                              const periodStr = card ? calcBillingPeriod(card.closingDay, tx.date) : null;
                              return (
                                <span style={{ fontSize: 11, color: card ? card.color : "#a0c0ff", background: "#1a2040", borderRadius: 4, padding: "2px 6px", lineHeight: 1.6 }}>
                                  💳 {card ? card.name : "クレカ"}{payStr ? ` → ${payStr}` : ""}{periodStr ? ` (${periodStr})` : ""}
                                </span>
                              );
                            })() : <span style={{ fontSize: 11, color: "#70a070", background: "#1a2a1a", borderRadius: 4, padding: "1px 6px" }}>💴 現金</span>}
                            <span style={{ fontSize: 11, color: "#4a4a5a" }}>{tx.date}</span>
                          </div>
                        </div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: tx.type === "income" ? "#50c878" : "#e8e4dc" }}>{tx.type === "income" ? "+" : "-"}{formatMoney(tx.amount)}</div>
                        <button onClick={() => deleteTx(tx.id)} style={{ background: "none", border: "none", color: "#3a3a4a", cursor: "pointer", fontSize: 16, padding: 4 }}>×</button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* ===== BUDGET ===== */}
        {tab === "budget" && (() => {
          const nowD = new Date();
          const daysPassed = nowD.getDate();
          const daysInThisMonth = new Date(nowD.getFullYear(), nowD.getMonth() + 1, 0).getDate();
          const monthProgress = daysPassed / daysInThisMonth;

          // カテゴリ名と支出カテゴリのマッピング（1対1）
          const CATEGORY_MAP = {
            "食費": ["食費"],
            "日用品": ["日用品"],
            "交通費": ["交通費"],
            "娯楽": ["娯楽"],
            "医療": ["医療"],
            "交際費": ["交際費"],
            "その他": ["その他"],
          };

          // 今月の支出合計（カテゴリ別）
          const spentByCategory = {};
          transactions.filter(t => t.type === "expense").forEach(t => {
            spentByCategory[t.category] = (spentByCategory[t.category] || 0) + t.amount;
          });

          // 今月の全支出合計
          const totalSpent = transactions.filter(t => t.type === "expense").reduce((s,t) => s + t.amount, 0);

          // AI判定ロジック
          const getStatus = (spent, budget, isFixed) => {
            if (isFixed || budget === 0) return "fixed";
            const expectedByNow = budget * monthProgress;
            const ratio = spent / budget;
            const paceRatio = spent / expectedByNow;
            if (ratio >= 1) return "over";
            if (paceRatio > 1.2) return "warning";
            if (ratio > 0.8) return "caution";
            return "good";
          };

          const statusConfig = {
            fixed:   { color: "#5a5a6a", bg: "#1e1e2a", bar: "#3a3a4a", label: "固定費", icon: "🔒" },
            good:    { color: "#50c878", bg: "#1a2a1a", bar: "#50c878", label: "良好",   icon: "✓" },
            caution: { color: "#f0c060", bg: "#2a2010", bar: "#f0c060", label: "注意",   icon: "△" },
            warning: { color: "#e07030", bg: "#2a1a10", bar: "#e07030", label: "要注意", icon: "⚠" },
            over:    { color: "#e05050", bg: "#2a1010", bar: "#e05050", label: "超過",   icon: "✕" },
          };

          const fixedCategories = ["既存返済","新規返済","積立予備費","予備費","NISA"];
          const variableCategories = budget.allocations.filter(a => a.amount > 0 && !fixedCategories.includes(a.category));
          const fixedAllocations = budget.allocations.filter(a => fixedCategories.includes(a.category) || a.amount === 0);

          // カテゴリ別支出を直接取得
          const getSpentForAlloc = (category) => {
            const cats = CATEGORY_MAP[category];
            if (!cats) return 0;
            return cats.reduce((s, c) => s + (spentByCategory[c] || 0), 0);
          };

          // 全体の総評
          const totalBudgetVariable = variableCategories.reduce((s,a) => s + a.amount, 0);
          const totalSpentVariable = variableCategories.reduce((s,a) => s + getSpentForAlloc(a.category), 0);
          const overallPace = totalBudgetVariable > 0 ? totalSpentVariable / (totalBudgetVariable * monthProgress) : 0;
          const overallStatus = overallPace > 1.3 ? "over" : overallPace > 1.1 ? "warning" : overallPace > 0.9 ? "caution" : "good";
          const overallMsg = {
            over:    "⚠ 変動費が予算ペースを大きく超えています。支出を抑えましょう。",
            warning: "△ 変動費がペースより少し多めです。残り日数で調整が必要です。",
            caution: "◎ おおむね順調なペースです。このまま続けましょう。",
            good:    "✓ 変動費は予算内に収まっています。素晴らしいペースです！",
          }[overallStatus];

          return (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            {/* ヘッダー */}
            <div style={{ background: "linear-gradient(135deg,#1e1a10,#1a1a24)", border: "1px solid #3a3218", borderRadius: 16, padding: "20px", marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "#8a7a4a", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 4 }}>今月の予算プラン</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: "#f0c060" }}>{formatMoney(budget.salary)}<span style={{ fontSize: 14, color: "#7a6a3a", fontWeight: 400 }}> / 月</span></div>
                  <div style={{ fontSize: 12, color: "#6a5a3a", marginTop: 4 }}>🐢 返済優先プラン · {budget.generatedAt}設定</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 11, color: "#6a5a3a" }}>月の進捗</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#f0c060" }}>{daysPassed}/{daysInThisMonth}日</div>
                  <div style={{ fontSize: 11, color: "#6a5a3a" }}>{Math.round(monthProgress * 100)}%経過</div>
                </div>
              </div>
              {/* 合計支出サマリー */}
              {(() => {
                const totalBudget = budget.salary;
                const totalSpentAll = transactions.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
                const totalRemaining = totalBudget - totalSpentAll;
                const totalPct = Math.min(100, (totalSpentAll / totalBudget) * 100);
                const isOver = totalSpentAll > totalBudget;
                return (
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <div>
                        <div style={{ fontSize: 11, color: "#8a7a4a" }}>合計支出</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: isOver ? "#e05050" : "#e8e4dc" }}>{formatMoney(totalSpentAll)}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 11, color: "#8a7a4a" }}>残り予算</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: isOver ? "#e05050" : "#50c878" }}>{formatMoney(totalRemaining)}</div>
                      </div>
                    </div>
                    <div style={{ background: "#12121a", borderRadius: 6, height: 8 }}>
                      <div style={{ height: 8, borderRadius: 6, width: `${totalPct}%`, background: isOver ? "linear-gradient(90deg,#e05050,#c03030)" : "linear-gradient(90deg,#f0c060,#e07030)", transition: "width 0.6s" }} />
                    </div>
                    <div style={{ fontSize: 11, color: "#6a5a3a", textAlign: "right", marginTop: 4 }}>{totalPct.toFixed(1)}% 使用</div>
                  </div>
                );
              })()}
            </div>

            {/* AI総評 */}
            <div style={{ background: statusConfig[overallStatus].bg, border: `1px solid ${statusConfig[overallStatus].color}40`, borderRadius: 12, padding: "14px 16px", marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: statusConfig[overallStatus].color, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>AIによる使いすぎ判定</div>
              <div style={{ fontSize: 13, color: "#e8e4dc", lineHeight: 1.7 }}>{overallMsg}</div>
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                {variableCategories.map(a => {
                  const spent = getSpentForAlloc(a.category);
                  const st = getStatus(spent, a.amount, false);
                  const sc = statusConfig[st];
                  return (
                    <span key={a.category} style={{ fontSize: 11, background: sc.bg, color: sc.color, borderRadius: 6, padding: "3px 8px", border: `1px solid ${sc.color}40` }}>
                      {sc.icon} {a.category}
                    </span>
                  );
                })}
              </div>
            </div>

            {/* 変動費 進捗 */}
            <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>変動費の進捗</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
              {variableCategories.map(({ category, amount, reason }) => {
                const spent = getSpentForAlloc(category);
                const st = getStatus(spent, amount, false);
                const sc = statusConfig[st];
                const pct = amount > 0 ? Math.min(100, (spent / amount) * 100) : 0;
                const expectedByNow = Math.round(amount * monthProgress);
                const remaining = amount - spent;
                return (
                  <div key={category} style={{ background: sc.bg, borderRadius: 12, padding: "14px 16px", border: `1px solid ${sc.color}30` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 12 }}>{sc.icon}</span>
                          <span style={{ fontSize: 14, fontWeight: 600, color: "#e8e4dc" }}>{category}</span>
                          <span style={{ fontSize: 10, color: sc.color, background: sc.color + "20", borderRadius: 4, padding: "1px 5px" }}>{sc.label}</span>
                        </div>
                        <div style={{ fontSize: 11, color: "#5a5a6a", marginTop: 3 }}>
                          予算: {formatMoney(amount)} · 本日時点の目安: {formatMoney(expectedByNow)}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: sc.color }}>{formatMoney(spent)}</div>
                        <div style={{ fontSize: 11, color: remaining >= 0 ? "#5a8a5a" : "#8a5a5a" }}>
                          {remaining >= 0 ? `残 ${formatMoney(remaining)}` : `${formatMoney(-remaining)} 超過`}
                        </div>
                      </div>
                    </div>
                    <div style={{ background: "#0f0f1380", borderRadius: 4, height: 6 }}>
                      <div style={{ height: 6, borderRadius: 4, width: `${pct}%`, background: sc.bar, transition: "width 0.6s" }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                      <span style={{ fontSize: 10, color: "#3a3a4a" }}>¥0</span>
                      <span style={{ fontSize: 10, color: "#5a5a6a" }}>目安 {Math.round(monthProgress * 100)}%</span>
                      <span style={{ fontSize: 10, color: "#3a3a4a" }}>{formatMoney(amount)}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 固定費 */}
            <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>固定費・返済</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
              {fixedAllocations.map(({ category, amount, reason }) => {
                const isStopped = amount === 0;
                return (
                  <div key={category} style={{ background: "#1a1a24", borderRadius: 10, padding: "12px 16px", border: "1px solid #2a2a38", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: isStopped ? "#3a3a4a" : "#9a9aaa" }}>{category}</div>
                      <div style={{ fontSize: 11, color: "#4a4a5a", marginTop: 1 }}>{reason}</div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: isStopped ? "#3a3a4a" : "#6a6a7a" }}>{isStopped ? "停止中" : formatMoney(amount)}</div>
                  </div>
                );
              })}
            </div>

            <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: "1px solid #2a2a38", display: "flex", justifyContent: "space-between" }}>
              <div style={{ fontSize: 13, color: "#7a7a8a" }}>予算合計</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#f0c060" }}>{formatMoney(budget.allocations.reduce((s, a) => s + a.amount, 0))}<span style={{ fontSize: 11, color: "#5a5a6a", fontWeight: 400 }}> / {formatMoney(budget.salary)}</span></div>
            </div>
          </div>
          );
        })()}

        {/* ===== LOAN ===== */}
        {tab === "loan" && (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            <div style={{ background: "linear-gradient(135deg,#1a1020,#12101a)", border: "1px solid #3a2a40", borderRadius: 16, padding: "24px 20px", marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: "#8a6a9a", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 16 }}>返済進捗</div>
              <div style={{ position: "relative", marginBottom: 20 }}>
                <div style={{ background: "#1e1628", borderRadius: 12, height: 14, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${progressPct}%`, background: "linear-gradient(90deg,#a060f0,#f0c060)", borderRadius: 12, transition: "width 0.8s ease" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                  <span style={{ fontSize: 11, color: "#6a5a7a" }}>開始</span>
                  <span style={{ fontSize: 12, color: "#a080c0", fontWeight: 700 }}>{progressPct.toFixed(1)}% 完了</span>
                  <span style={{ fontSize: 11, color: "#6a5a7a" }}>完済</span>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {[
                  ["残債", formatMoney(Math.round(currentBalance)), "#e070a0"],
                  ["完済予定", completionDate, "#f0c060"],
                  ["残り回数", `${remainingMonths}ヶ月`, "#a0c0f0"],
                  ["返済済み", `${loanPaidMonths}ヶ月`, "#50c878"],
                ].map(([label, value, color]) => (
                  <div key={label} style={{ background: "#12101a", borderRadius: 10, padding: "14px" }}>
                    <div style={{ fontSize: 11, color: "#6a5a7a", marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: "1px solid #2a2a38", marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>返済回数を記録</div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button onClick={() => updateLoanPaid(Math.max(0, loanPaidMonths - 1))} style={{ width: 40, height: 40, borderRadius: 10, background: "#12121a", border: "1px solid #2a2a38", color: "#e8e4dc", fontSize: 20, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                <div style={{ flex: 1, textAlign: "center" }}>
                  <div style={{ fontSize: 32, fontWeight: 700, color: "#50c878" }}>{loanPaidMonths}</div>
                  <div style={{ fontSize: 11, color: "#5a5a6a" }}>ヶ月返済済み</div>
                </div>
                <button onClick={() => updateLoanPaid(Math.min(totalMonths, loanPaidMonths + 1))} style={{ width: 40, height: 40, borderRadius: 10, background: "linear-gradient(135deg,#50c878,#30a858)", border: "none", color: "#0f0f13", fontSize: 20, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>＋</button>
              </div>
              <div style={{ fontSize: 11, color: "#4a4a5a", textAlign: "center", marginTop: 8 }}>毎月返済したら＋を押してください</div>
            </div>
            <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: "1px solid #2a2a38", marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>ローン情報</div>
              {[
                ["元金", formatMoney(LOAN_INFO.principal)],
                ["金利", `年${LOAN_INFO.annualRate}%`],
                ["月返済額", formatMoney(LOAN_INFO.monthlyPayment)],
                ["総返済回数", `${totalMonths}ヶ月`],
                ["総利息（見込み）", formatMoney(totalInterest)],
                ["支払済み利息", formatMoney(paidInterest)],
              ].map(([label, value]) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #1e1e2a" }}>
                  <span style={{ fontSize: 13, color: "#6a6a7a" }}>{label}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#e8e4dc" }}>{value}</span>
                </div>
              ))}
            </div>
            <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: "1px solid #2a2a38" }}>
              <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>返済スケジュール（今後6ヶ月）</div>
              {schedule.slice(loanPaidMonths, loanPaidMonths + 6).map((row, i) => {
                const [y, m] = row.date.split("-");
                return (
                  <div key={row.month} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: i < 5 ? "1px solid #1e1e2a" : "none" }}>
                    <div style={{ width: 28, height: 28, borderRadius: 8, background: i === 0 ? "linear-gradient(135deg,#a060f0,#f0c060)" : "#22222e", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: i === 0 ? "#0f0f13" : "#5a5a6a" }}>{row.month}</span>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: i === 0 ? "#e8e4dc" : "#8a8a9a" }}>{y}年{parseInt(m)}月</div>
                      <div style={{ fontSize: 11, color: "#5a5a6a" }}>うち利息 {formatMoney(row.interest)}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#e07030" }}>−{formatMoney(LOAN_INFO.monthlyPayment)}</div>
                      <div style={{ fontSize: 11, color: "#5a5a6a" }}>残 {formatMoney(Math.round(row.balance))}</div>
                    </div>
                  </div>
                );
              })}
              {loanPaidMonths >= totalMonths && <div style={{ textAlign: "center", padding: 20, fontSize: 20 }}>🎉 完済おめでとうございます！</div>}
            </div>
          </div>
        )}

        {/* ===== DIET ===== */}
        {tab === "diet" && (() => {
          const latestWeight = weightLog.length > 0 ? [...weightLog].sort((a,b) => b.date.localeCompare(a.date))[0].weight : START_WEIGHT;
          const lostWeight = START_WEIGHT - latestWeight;
          const remainWeight = latestWeight - TARGET_WEIGHT;
          const progressPct = Math.min(100, (lostWeight / (START_WEIGHT - TARGET_WEIGHT)) * 100);
          const todayNutrition = nutritionLog.find(n => n.date === today());
          const todayKcal = todayNutrition ? Number(todayNutrition.kcal) || 0 : 0;
          const kcalPct = Math.min(100, (todayKcal / DAILY_KCAL_TARGET) * 100);
          const kcalRemaining = DAILY_KCAL_TARGET - todayKcal;

          return (
          <div style={{ animation: "fadeIn 0.3s ease" }}>

            {/* 今日やること */}
            {(() => {
              const todayExerciseDone = exerciseLog.some(e => e.date === today());
              const todayWeightDone = weightLog.some(w => w.date === today());
              const todayMealCount = todayNutrition ? 1 : 0;
              const todayKcalDone = todayKcal <= DAILY_KCAL_TARGET && todayKcal > 0;

              // 手動チェック・筋トレ（dailyTasksより前に定義）
              const manualKey = `diet-manual-${today()}`;
              const manualChecks = (() => { try { return JSON.parse(localStorage.getItem(manualKey) || "{}"); } catch { return {}; } })();
              const toggleManual = (id) => {
                const current = (() => { try { return JSON.parse(localStorage.getItem(manualKey) || "{}"); } catch { return {}; } })();
                const next = { ...current, [id]: !current[id] };
                localStorage.setItem(manualKey, JSON.stringify(next));
                setDietRefresh(r => r + 1);
              };
              const todayDow = new Date().getDay();
              const todayWorkout = WORKOUT_SCHEDULE[todayDow];
              const workoutDone = !!manualChecks["workout"];

              const dailyTasks = [
                {
                  id: "weight",
                  done: todayWeightDone,
                  icon: "⚖️",
                  title: "体重を記録する",
                  detail: `毎朝起床後、トイレの後に計測。今日の目標: ${(latestWeight - MONTHLY_GOAL / 30).toFixed(1)}kg以下`,
                  action: "下の「体重を記録」に入力してください",
                },
                {
                  id: "breakfast",
                  done: !!todayNutrition,
                  icon: "🌅",
                  title: "朝食を食べて記録する",
                  detail: "朝食は必ず食べる（抜くと夜の過食につながる）。目安: 400〜500kcal",
                  action: "下の「食事を記録」に朝食を入力",
                },
                {
                  id: "lunch",
                  done: !!todayNutrition,
                  icon: "🍱",
                  title: "昼食を食べて記録する",
                  detail: "弁当持参推奨。目安: 500〜600kcal。クレカ支払いに注意",
                  action: "下の「食事を記録」に昼食を入力",
                },
                {
                  id: "dinner",
                  done: !!todayNutrition,
                  icon: "🌙",
                  title: "夕食を食べて記録する",
                  detail: "炭水化物を半分に。夜9時以降は食べない。目安: 500〜600kcal",
                  action: "下の「食事を記録」に夕食を入力",
                },
                {
                  id: "kcal",
                  done: todayKcalDone,
                  icon: "📊",
                  title: `1日${DAILY_KCAL_TARGET}kcal以内に抑える`,
                  detail: `現在の摂取: ${todayKcal}kcal / 残り: ${DAILY_KCAL_TARGET - todayKcal}kcal`,
                  action: "食事記録を続けてカロリーを確認",
                },
                {
                  id: "walk",
                  done: todayExerciseDone,
                  icon: "🚶",
                  title: "歩いてApple Watchの記録を入力する",
                  detail: "目標: 8,000歩 / 30分以上のウォーキング。無理せず継続が大事",
                  action: "下の「Apple Watch 記録」に入力",
                },
                {
                  id: "water",
                  done: false,
                  icon: "💧",
                  title: "水を2L飲む",
                  detail: "代謝アップ・食欲抑制に効果的。食事の前にコップ1杯飲む",
                  action: "意識して水分補給を心がける",
                },
                {
                  id: "nosnack",
                  done: false,
                  icon: "🚫",
                  title: "夜9時以降は食べない",
                  detail: "クエチアピン服用後の夜間食欲に注意。甘いものは家に置かない",
                  action: "夜食の代わりに温かいお茶やスープを飲む",
                },
                {
                  id: "workout",
                  done: workoutDone,
                  icon: todayWorkout.rest ? "😴" : "💪",
                  title: todayWorkout.rest ? `今日は${todayWorkout.name}` : `筋トレ：${todayWorkout.name}`,
                  detail: todayWorkout.rest
                    ? "しっかり休んで筋肉を回復させる。ウォーキングは軽くOK"
                    : todayWorkout.exercises.map(e => `${e.name} ${e.sets}セット×${e.reps}`).join("、"),
                  action: todayWorkout.rest ? "無理せず休む" : "下の筋トレ記録を確認してください",
                },
              ];

              const resolvedTasks = dailyTasks.map(t => ({
                ...t,
                done: t.done || !!manualChecks[t.id],
              }));
              const doneCount = resolvedTasks.filter(t => t.done).length;
              const allDone = doneCount === resolvedTasks.length;

              return (
                <div style={{ background: allDone ? "#1a2a1a" : "#1a1a24", borderRadius: 12, padding: 16, border: `1px solid ${allDone ? "#2a4a2a" : "#2a2a38"}`, marginBottom: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div style={{ fontSize: 11, color: allDone ? "#50c878" : "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                      {allDone ? "✓ 今日のタスク完了！" : "📋 今日やること"}
                    </div>
                    <div style={{ fontSize: 12, color: "#7a7a8a" }}>{doneCount}/{resolvedTasks.length} 完了</div>
                  </div>
                  {/* 進捗バー */}
                  <div style={{ background: "#12121a", borderRadius: 4, height: 6, marginBottom: 14 }}>
                    <div style={{ height: 6, borderRadius: 4, width: `${(doneCount / resolvedTasks.length) * 100}%`, background: allDone ? "#50c878" : "linear-gradient(90deg,#f0c060,#50c878)", transition: "width 0.4s" }} />
                  </div>
                  {resolvedTasks.map((t, i) => (
                    <div key={t.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 0", borderBottom: i < resolvedTasks.length - 1 ? "1px solid #1e1e2a" : "none", opacity: t.done ? 0.6 : 1 }}>
                      <button
                        onClick={() => { if (!t.done || manualChecks[t.id]) toggleManual(t.id); }}
                        style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${t.done ? "#50c878" : "#3a3a4a"}`, background: t.done ? "#50c87830" : "none", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer", marginTop: 1 }}>
                        {t.done && <span style={{ color: "#50c878", fontSize: 12 }}>✓</span>}
                      </button>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                          <span style={{ fontSize: 14 }}>{t.icon}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: t.done ? "#4a7a4a" : "#e8e4dc", textDecoration: t.done ? "line-through" : "none" }}>{t.title}</span>
                        </div>
                        <div style={{ fontSize: 11, color: "#6a6a7a", lineHeight: 1.5 }}>{t.detail}</div>
                        {!t.done && <div style={{ fontSize: 11, color: "#5a7a9a", marginTop: 3 }}>→ {t.action}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* 目標進捗 */}
            <div style={{ background: "linear-gradient(135deg,#1a1824,#12101a)", border: "1px solid #3a2a40", borderRadius: 16, padding: "20px", marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: "#8a6a9a", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 12 }}>12ヶ月ダイエット進捗</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
                {[
                  ["現在", `${latestWeight}kg`, "#e8e4dc"],
                  ["目標", `${TARGET_WEIGHT}kg`, "#50c878"],
                  ["あと", `${remainWeight.toFixed(1)}kg`, "#f0c060"],
                ].map(([label, value, color]) => (
                  <div key={label} style={{ background: "#12101a", borderRadius: 10, padding: "12px", textAlign: "center" }}>
                    <div style={{ fontSize: 11, color: "#6a5a7a", marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
                  </div>
                ))}
              </div>
              <div style={{ background: "#1e1628", borderRadius: 6, height: 10, marginBottom: 6 }}>
                <div style={{ height: 10, borderRadius: 6, width: `${progressPct}%`, background: "linear-gradient(90deg,#a060f0,#50c878)", transition: "width 0.8s" }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
                <span style={{ fontSize: 11, color: "#6a5a7a" }}>{START_WEIGHT}kg</span>
                <span style={{ fontSize: 12, color: "#a080c0", fontWeight: 700 }}>{progressPct.toFixed(1)}% 達成</span>
                <span style={{ fontSize: 11, color: "#6a5a7a" }}>{TARGET_WEIGHT}kg</span>
              </div>

              {/* 月別目標グラフ */}
              <div style={{ fontSize: 11, color: "#6a5a7a", marginBottom: 8 }}>月別目標 vs 実績（月{MONTHLY_GOAL.toFixed(1)}kg減）</div>
              <svg viewBox="0 0 320 120" style={{ width: "100%", height: 120, overflow: "visible" }}>
                {Array.from({ length: PLAN_MONTHS }, (_, i) => {
                  const monthGoalWeight = START_WEIGHT - MONTHLY_GOAL * (i + 1);
                  const x = (i / (PLAN_MONTHS - 1)) * 300 + 10;
                  // 実績: その月の最後の体重記録
                  const planDate = new Date(PLAN_START);
                  planDate.setMonth(planDate.getMonth() + i + 1);
                  const ym = planDate.toISOString().slice(0, 7);
                  const monthLogs = weightLog.filter(w => w.date.startsWith(ym));
                  const actualWeight = monthLogs.length > 0 ? monthLogs[monthLogs.length - 1].weight : null;
                  const minW = TARGET_WEIGHT - 1;
                  const maxW = START_WEIGHT + 1;
                  const range = maxW - minW;
                  const goalY = 110 - ((monthGoalWeight - minW) / range * 100);
                  const actualY = actualWeight ? 110 - ((actualWeight - minW) / range * 100) : null;
                  return (
                    <g key={i}>
                      <circle cx={x} cy={goalY} r="3" fill="#a060f050" stroke="#a060f0" strokeWidth="1" />
                      {i > 0 && (() => {
                        const px = ((i-1) / (PLAN_MONTHS - 1)) * 300 + 10;
                        const prevGoalY = 110 - (((START_WEIGHT - MONTHLY_GOAL * i) - minW) / range * 100);
                        return <line x1={px} y1={prevGoalY} x2={x} y2={goalY} stroke="#a060f060" strokeWidth="1" strokeDasharray="3,3" />;
                      })()}
                      {actualY && <circle cx={x} cy={actualY} r="4" fill="#50c878" />}
                      <text x={x} y="118" textAnchor="middle" fontSize="7" fill="#5a5a6a">{i+1}月</text>
                    </g>
                  );
                })}
              </svg>
              <div style={{ display: "flex", gap: 16, marginTop: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#6a5a7a" }}>
                  <div style={{ width: 12, height: 2, background: "#a060f060", borderRadius: 1 }} /> 目標ライン
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#6a5a7a" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#50c878" }} /> 実績
                </div>
              </div>

              {/* 月別目標テーブル */}
              <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 4 }}>
                {Array.from({ length: PLAN_MONTHS }, (_, i) => {
                  const monthGoalWeight = (START_WEIGHT - MONTHLY_GOAL * (i + 1)).toFixed(1);
                  const planDate = new Date(PLAN_START);
                  planDate.setMonth(planDate.getMonth() + i + 1);
                  const ym = planDate.toISOString().slice(0, 7);
                  const label = `${planDate.getFullYear()}年${planDate.getMonth() + 1}月`;
                  const monthLogs = weightLog.filter(w => w.date.startsWith(ym));
                  const actualWeight = monthLogs.length > 0 ? [...monthLogs].sort((a,b) => b.date.localeCompare(a.date))[0].weight : null;
                  const diff = actualWeight ? (actualWeight - Number(monthGoalWeight)).toFixed(1) : null;
                  const isOver = diff > 0;
                  const isCurrent = new Date().toISOString().slice(0,7) === ym;
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, background: isCurrent ? "#1e1828" : "transparent", border: isCurrent ? "1px solid #3a2a40" : "1px solid transparent" }}>
                      <span style={{ fontSize: 11, color: isCurrent ? "#a080c0" : "#5a5a6a", minWidth: 70 }}>{label}</span>
                      <span style={{ fontSize: 11, color: "#6a6a7a", minWidth: 50 }}>目標 {monthGoalWeight}kg</span>
                      {actualWeight ? (
                        <span style={{ fontSize: 11, color: isOver ? "#e05050" : "#50c878", fontWeight: 600 }}>
                          実績 {actualWeight}kg（{isOver ? "+" : ""}{diff}kg）
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: "#3a3a4a" }}>未記録</span>
                      )}
                      {isCurrent && <span style={{ fontSize: 10, color: "#a080c0", marginLeft: "auto" }}>← 今月</span>}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 今日のカロリー */}
            <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: `1px solid ${kcalPct > 100 ? "#3a2020" : "#2a2a38"}`, marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>今日のカロリー</div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 11, color: "#5a5a6a" }}>摂取済み</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: kcalPct > 100 ? "#e05050" : "#f0c060" }}>{todayKcal}<span style={{ fontSize: 12, color: "#5a5a6a" }}>kcal</span></div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 11, color: "#5a5a6a" }}>{kcalRemaining >= 0 ? "残り" : "超過"}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: kcalRemaining >= 0 ? "#50c878" : "#e05050" }}>{Math.abs(kcalRemaining)}<span style={{ fontSize: 12, color: "#5a5a6a" }}>kcal</span></div>
                </div>
              </div>
              <div style={{ background: "#12121a", borderRadius: 6, height: 8, marginBottom: 6 }}>
                <div style={{ height: 8, borderRadius: 6, width: `${kcalPct}%`, background: kcalPct > 100 ? "linear-gradient(90deg,#e05050,#c03030)" : "linear-gradient(90deg,#f0c060,#50c878)", transition: "width 0.6s" }} />
              </div>
              <div style={{ fontSize: 11, color: "#5a5a6a", textAlign: "center" }}>目標: {DAILY_KCAL_TARGET}kcal / 日</div>
            </div>

            {/* 体重記録 */}
            <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: "1px solid #2a2a38", marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>体重を記録</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input type="number" value={newWeight} onChange={e => setNewWeight(e.target.value)} placeholder="例: 84.5" step="0.1"
                  style={{ flex: 1, ...inp }} onKeyDown={e => { if (e.key === "Enter" && newWeight) { const entry = { id: Date.now(), date: today(), weight: Number(newWeight) }; updateWeightLog([...weightLog, entry]); setNewWeight(""); } }} />
                <span style={{ display: "flex", alignItems: "center", color: "#5a5a6a", fontSize: 14 }}>kg</span>
                <button onClick={() => { if (newWeight) { const entry = { id: Date.now(), date: today(), weight: Number(newWeight) }; updateWeightLog([...weightLog, entry]); setNewWeight(""); } }}
                  style={{ background: "linear-gradient(135deg,#f0c060,#e07030)", border: "none", borderRadius: 8, padding: "8px 20px", color: "#0f0f13", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>記録</button>
              </div>
            </div>

            {/* 体重グラフ */}
            {weightLog.length > 0 && (
              <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: "1px solid #2a2a38", marginBottom: 20 }}>
                <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>体重の推移</div>
                {(() => {
                  const sorted = [...weightLog].sort((a,b) => a.date.localeCompare(b.date)).slice(-14);
                  const minW = Math.min(...sorted.map(d => d.weight)) - 1;
                  const maxW = Math.max(...sorted.map(d => d.weight)) + 1;
                  const range = maxW - minW;
                  const W = 300, H = 100;
                  return (
                    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 100 }}>
                      <line x1="0" y1={H - ((TARGET_WEIGHT - minW) / range * H)} x2={W} y2={H - ((TARGET_WEIGHT - minW) / range * H)} stroke="#50c87840" strokeWidth="1" strokeDasharray="4,4" />
                      {sorted.map((d, i) => {
                        const x = sorted.length === 1 ? W/2 : (i / (sorted.length - 1)) * (W - 20) + 10;
                        const y = H - ((d.weight - minW) / range * (H - 10)) - 5;
                        return (
                          <g key={d.id}>
                            {i > 0 && (() => {
                              const px = ((i-1) / (sorted.length - 1)) * (W - 20) + 10;
                              const py = H - ((sorted[i-1].weight - minW) / range * (H - 10)) - 5;
                              return <line x1={px} y1={py} x2={x} y2={y} stroke="#a060f0" strokeWidth="2" />;
                            })()}
                            <circle cx={x} cy={y} r="3" fill="#f0c060" />
                            <text x={x} y={y - 6} textAnchor="middle" fontSize="8" fill="#9a9aaa">{d.weight}</text>
                          </g>
                        );
                      })}
                    </svg>
                  );
                })()}
                <div style={{ fontSize: 10, color: "#50c878", textAlign: "right" }}>-- 目標{TARGET_WEIGHT}kg</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
                  {[...weightLog].sort((a,b) => b.date.localeCompare(a.date)).slice(0, 5).map(w => (
                    <div key={w.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#7a7a8a", padding: "4px 0", borderBottom: "1px solid #1e1e2a" }}>
                      <span>{w.date}</span>
                      <span style={{ color: "#e8e4dc", fontWeight: 600 }}>{w.weight}kg</span>
                      <button onClick={() => updateWeightLog(weightLog.filter(x => x.id !== w.id))} style={{ background: "none", border: "none", color: "#4a4a5a", cursor: "pointer", fontSize: 14 }}>×</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 今日の筋トレメニュー */}
            {(() => {
              const todayDow = new Date().getDay();
              const todayWorkout = WORKOUT_SCHEDULE[todayDow];
              if (todayWorkout.rest) return null;
              const manualKey = `diet-manual-${today()}`;
              const manualChecks = (() => { try { return JSON.parse(localStorage.getItem(manualKey) || "{}"); } catch { return {}; } })();
              const workoutDone = !!manualChecks["workout"];
              return (
                <div style={{ background: workoutDone ? "#1a2a1a" : "#1a1a24", borderRadius: 12, padding: 16, border: `1px solid ${workoutDone ? "#2a4a2a" : "#2a2a38"}`, marginBottom: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div style={{ fontSize: 11, color: workoutDone ? "#50c878" : "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                      💪 今日の筋トレ：{todayWorkout.name}
                    </div>
                    <button
                      onClick={() => {
                        const current = (() => { try { return JSON.parse(localStorage.getItem(manualKey) || "{}"); } catch { return {}; } })();
                        const next = { ...current, workout: !current["workout"] };
                        localStorage.setItem(manualKey, JSON.stringify(next));
                        setDietRefresh(r => r + 1);
                      }}
                      style={{ background: workoutDone ? "#2a4a2a" : "linear-gradient(135deg,#f0c060,#e07030)", border: "none", borderRadius: 8, padding: "6px 14px", color: workoutDone ? "#50c878" : "#0f0f13", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                      {workoutDone ? "✓ 完了！" : "完了にする"}
                    </button>
                  </div>
                  {todayWorkout.exercises.map((ex, i) => (
                    <div key={i} style={{ padding: "10px 0", borderBottom: i < todayWorkout.exercises.length - 1 ? "1px solid #1e1e2a" : "none" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "#e8e4dc" }}>{ex.name}</div>
                        <div style={{ fontSize: 13, color: "#f0c060", fontWeight: 700 }}>{ex.sets}セット × {ex.reps}</div>
                      </div>
                      <div style={{ fontSize: 11, color: "#6a6a7a" }}>💡 {ex.tip}</div>
                      {ex.rest && <div style={{ fontSize: 11, color: "#5a7a9a", marginTop: 2 }}>⏱ {ex.rest}</div>}
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* 今日の消費カロリー（Apple Watch） */}
            {(() => {
              const todayExercise = exerciseLog.filter(e => e.date === today());
              const todayBurned = todayExercise.reduce((s, e) => s + (Number(e.burnedKcal) || 0), 0);
              const netKcal = todayKcal - todayBurned;
              return (
                <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: "1px solid #2a2a38", marginBottom: 20 }}>
                  <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>🍎 Apple Watch 記録</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
                    <div style={{ background: "#12121a", borderRadius: 10, padding: "12px", textAlign: "center" }}>
                      <div style={{ fontSize: 11, color: "#5a5a6a", marginBottom: 4 }}>摂取</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: "#f0c060" }}>{todayKcal}<span style={{ fontSize: 10, color: "#5a5a6a" }}>kcal</span></div>
                    </div>
                    <div style={{ background: "#12121a", borderRadius: 10, padding: "12px", textAlign: "center" }}>
                      <div style={{ fontSize: 11, color: "#5a5a6a", marginBottom: 4 }}>消費</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: "#50c878" }}>{todayBurned}<span style={{ fontSize: 10, color: "#5a5a6a" }}>kcal</span></div>
                    </div>
                    <div style={{ background: "#12121a", borderRadius: 10, padding: "12px", textAlign: "center" }}>
                      <div style={{ fontSize: 11, color: "#5a5a6a", marginBottom: 4 }}>収支</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: netKcal > DAILY_KCAL_TARGET ? "#e05050" : "#50c878" }}>{netKcal}<span style={{ fontSize: 10, color: "#5a5a6a" }}>kcal</span></div>
                    </div>
                  </div>
                  {/* 入力フォーム */}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                    <input type="number" value={newExercise.steps} onChange={e => setNewExercise({...newExercise, steps: e.target.value})} placeholder="歩数"
                      style={{ flex: 1, ...inp, minWidth: 80 }} />
                    <input type="number" value={newExercise.burnedKcal} onChange={e => setNewExercise({...newExercise, burnedKcal: e.target.value})} placeholder="消費kcal"
                      style={{ flex: 1, ...inp, minWidth: 90 }} />
                    <input type="text" value={newExercise.speed} onChange={e => setNewExercise({...newExercise, speed: e.target.value})} placeholder="速度(km/h)"
                      style={{ flex: 1, ...inp, minWidth: 90 }} />
                    <input type="number" value={newExercise.duration} onChange={e => setNewExercise({...newExercise, duration: e.target.value})} placeholder="時間(分)"
                      style={{ flex: 1, ...inp, minWidth: 80 }} />
                    <input type="date" value={newExercise.date} onChange={e => setNewExercise({...newExercise, date: e.target.value})}
                      style={{ flex: 1, ...inp, minWidth: 130 }} />
                    <button onClick={() => { if (newExercise.burnedKcal) { updateExerciseLog([...exerciseLog, { ...newExercise, id: Date.now(), burnedKcal: Number(newExercise.burnedKcal), steps: Number(newExercise.steps) }]); setNewExercise({ steps: "", burnedKcal: "", speed: "", duration: "", date: today() }); } }}
                      style={{ background: "linear-gradient(135deg,#50c878,#30a858)", border: "none", borderRadius: 8, padding: "8px 16px", color: "#0f0f13", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>記録</button>
                  </div>
                  {/* 直近の運動記録 */}
                  {exerciseLog.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
                      {[...exerciseLog].sort((a,b) => b.date.localeCompare(a.date)).slice(0, 3).map(e => (
                        <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#7a7a8a", padding: "6px 0", borderBottom: "1px solid #1e1e2a" }}>
                          <span style={{ color: "#5a5a6a" }}>{e.date}</span>
                          {e.steps > 0 && <span>👟 {Number(e.steps).toLocaleString()}歩</span>}
                          {e.speed && <span>🚶 {e.speed}km/h</span>}
                          {e.duration && <span>⏱ {e.duration}分</span>}
                          <span style={{ marginLeft: "auto", color: "#50c878", fontWeight: 600 }}>−{e.burnedKcal}kcal</span>
                          <button onClick={() => updateExerciseLog(exerciseLog.filter(x => x.id !== e.id))} style={{ background: "none", border: "none", color: "#4a4a5a", cursor: "pointer", fontSize: 14 }}>×</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* 栄養記録（カロミルから転記） */}
            <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: "1px solid #2a2a38", marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>📊 栄養記録（カロミルから転記）</div>
              {/* 日付選択 */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <input type="date" value={newNutrition.date} onChange={e => setNewNutrition({...newNutrition, date: e.target.value})}
                  style={{ flex: 1, ...inp }} />
                <span style={{ fontSize: 12, color: "#5a5a6a" }}>の記録</span>
              </div>
              {/* 栄養素入力 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                {[
                  { key: "kcal", label: "カロリー", unit: "kcal", color: "#f0c060" },
                  { key: "protein", label: "たんぱく質", unit: "g", color: "#50c878" },
                  { key: "fat", label: "脂質", unit: "g", color: "#e07030" },
                  { key: "carbs", label: "炭水化物", unit: "g", color: "#6080e0" },
                  { key: "sugar", label: "糖質", unit: "g", color: "#e05050" },
                  { key: "fiber", label: "食物繊維", unit: "g", color: "#50c8a0" },
                  { key: "salt", label: "塩分", unit: "g", color: "#a060f0" },
                ].map(({ key, label, unit, color }) => (
                  <div key={key}>
                    <div style={{ fontSize: 11, color: color, marginBottom: 4 }}>{label}（{unit}）</div>
                    <input type="number" step="0.1" value={newNutrition[key]} onChange={e => setNewNutrition({...newNutrition, [key]: e.target.value})}
                      placeholder={`例: ${key === "kcal" ? "1978" : key === "salt" ? "13.1" : "63.4"}`}
                      style={{ ...inp }} />
                  </div>
                ))}
              </div>
              <button onClick={() => {
                if (!newNutrition.kcal) return;
                const existing = nutritionLog.find(n => n.date === newNutrition.date);
                const entry = { ...newNutrition, id: existing ? existing.id : Date.now(), kcal: Number(newNutrition.kcal), protein: Number(newNutrition.protein), fat: Number(newNutrition.fat), carbs: Number(newNutrition.carbs), sugar: Number(newNutrition.sugar), fiber: Number(newNutrition.fiber), salt: Number(newNutrition.salt) };
                const next = existing ? nutritionLog.map(n => n.date === newNutrition.date ? entry : n) : [...nutritionLog, entry];
                updateNutritionLog(next);
                setNewNutrition({ date: today(), kcal: "", protein: "", fat: "", carbs: "", sugar: "", fiber: "", salt: "" });
              }} style={{ width: "100%", padding: 12, borderRadius: 10, border: "none", background: "linear-gradient(135deg,#f0c060,#e07030)", color: "#0f0f13", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
                保存する（同じ日付は上書き）
              </button>
            </div>

            {/* 栄養記録の閲覧 */}
            <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: "1px solid #2a2a38", marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase" }}>記録を見る</div>
                <input type="date" value={nutritionViewDate} onChange={e => setNutritionViewDate(e.target.value)}
                  style={{ ...inp, width: "auto", fontSize: 12, padding: "6px 10px" }} />
              </div>
              {(() => {
                const rec = nutritionLog.find(n => n.date === nutritionViewDate);
                if (!rec) return <div style={{ textAlign: "center", color: "#3a3a4a", padding: 24, fontSize: 13 }}>この日の記録はありません</div>;
                return (
                  <div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
                      {[
                        { key: "kcal", label: "カロリー", unit: "kcal", color: "#f0c060", target: DAILY_KCAL_TARGET },
                        { key: "protein", label: "たんぱく質", unit: "g", color: "#50c878", target: 113 },
                        { key: "fat", label: "脂質", unit: "g", color: "#e07030", target: 75 },
                        { key: "carbs", label: "炭水化物", unit: "g", color: "#6080e0", target: 345 },
                        { key: "sugar", label: "糖質", unit: "g", color: "#e05050", target: 323 },
                        { key: "fiber", label: "食物繊維", unit: "g", color: "#50c8a0", target: 22 },
                        { key: "salt", label: "塩分", unit: "g", color: "#a060f0", target: 7.5 },
                      ].map(({ key, label, unit, color, target }) => {
                        const val = rec[key] || 0;
                        const pct = Math.min(100, (val / target) * 100);
                        const over = val > target;
                        return (
                          <div key={key} style={{ background: "#12121a", borderRadius: 8, padding: "10px 12px" }}>
                            <div style={{ fontSize: 11, color: color, marginBottom: 2 }}>{label}</div>
                            <div style={{ fontSize: 16, fontWeight: 700, color: over ? "#e05050" : "#e8e4dc" }}>{val}<span style={{ fontSize: 10, color: "#5a5a6a" }}>{unit}</span></div>
                            <div style={{ fontSize: 10, color: "#4a4a5a", marginBottom: 4 }}>目安 {target}{unit}</div>
                            <div style={{ background: "#1e1e2a", borderRadius: 3, height: 4 }}>
                              <div style={{ height: 4, borderRadius: 3, width: `${pct}%`, background: over ? "#e05050" : color, transition: "width 0.4s" }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <button onClick={() => updateNutritionLog(nutritionLog.filter(n => n.date !== nutritionViewDate))}
                      style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #3a2020", background: "none", color: "#7a4a4a", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                      この日の記録を削除
                    </button>
                  </div>
                );
              })()}
            </div>

            {/* 直近の記録一覧 */}
            <div style={{ background: "#1a1a24", borderRadius: 12, padding: 16, border: "1px solid #2a2a38" }}>
              <div style={{ fontSize: 11, color: "#5a5a6a", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>直近の栄養記録</div>
              {nutritionLog.length === 0 && <div style={{ textAlign: "center", color: "#3a3a4a", padding: 24, fontSize: 13 }}>記録がありません</div>}
              {[...nutritionLog].sort((a,b) => b.date.localeCompare(a.date)).slice(0, 7).map(n => (
                <div key={n.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid #1e1e2a" }}>
                  <div style={{ fontSize: 12, color: "#7a7a8a", minWidth: 80 }}>{n.date}</div>
                  <div style={{ flex: 1, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, color: "#f0c060", background: "#1e1a10", borderRadius: 4, padding: "1px 6px" }}>{n.kcal}kcal</span>
                    {n.protein > 0 && <span style={{ fontSize: 11, color: "#50c878", background: "#1a2a1a", borderRadius: 4, padding: "1px 6px" }}>P:{n.protein}g</span>}
                    {n.fat > 0 && <span style={{ fontSize: 11, color: "#e07030", background: "#2a1a10", borderRadius: 4, padding: "1px 6px" }}>F:{n.fat}g</span>}
                    {n.carbs > 0 && <span style={{ fontSize: 11, color: "#6080e0", background: "#1a1a30", borderRadius: 4, padding: "1px 6px" }}>C:{n.carbs}g</span>}
                  </div>
                  <button onClick={() => { setNutritionViewDate(n.date); }} style={{ background: "none", border: "1px solid #2a2a38", borderRadius: 6, padding: "2px 8px", color: "#7a7a8a", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>詳細</button>
                </div>
              ))}
            </div>
          </div>
          );
        })()}

      </div>
    </div>
  );
}
