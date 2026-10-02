/* Budget app: Arabic UI retained from the supplied HTML; cloud persistence through Supabase. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const CATEGORIES = ['مواصلات', 'أكل', 'مستلزمات', 'دروس', 'أخرى'];
  const DEFAULT_STATE = () => ({
    budget: 0, currency: 'ج.م', expenses: [],
    subjects: [
      { id: crypto.randomUUID(), name: 'الفيزياء', estimatedFee: 0, sessionsAttended: 0 },
      { id: crypto.randomUUID(), name: 'الكيمياء', estimatedFee: 0, sessionsAttended: 0 },
      { id: crypto.randomUUID(), name: 'عربي', estimatedFee: 0, sessionsAttended: 0 },
      { id: crypto.randomUUID(), name: 'أحياء', estimatedFee: 0, sessionsAttended: 0 },
      { id: crypto.randomUUID(), name: 'إنجليزي', estimatedFee: 0, sessionsAttended: 0 }
    ],
    subBudgets: Object.fromEntries(CATEGORIES.map((c) => [c, 0])),
    lessonPayments: [], notes: [], notificationSettings: { emailEnabled: false }
  });

  let supabaseClient;
  let currentUser;
  let appState = DEFAULT_STATE();
  let saveTimer;
  let saveQueue = Promise.resolve();
  let reportRows = [];
  let categoryChartInstance;
  let cumulativeChartInstance;
  let onConfirmAction = null;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (value) => Number(value || 0).toLocaleString('ar-EG', { maximumFractionDigits: 2 });
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
  const uid = () => crypto.randomUUID();
  const setMessage = (id, text, error = false) => { const el = $(id); if (el) { el.textContent = text; el.className = `text-xs min-h-5 mb-2 ${error ? 'text-rose-600' : 'text-emerald-700'}`; } };
  const setSync = (text, error = false) => { const el = $('syncStatus'); if (el) { el.textContent = text; el.className = error ? 'text-rose-200' : 'text-emerald-100'; } };
  const totalExpenses = () => appState.expenses.reduce((s, x) => s + Number(x.amount || 0), 0);
  const totalLessons = () => appState.lessonPayments.reduce((s, x) => s + Number(x.amount || 0), 0);
  const localDate = (date) => date ? new Date(`${date}T00:00:00`) : null;

  function normalizeState(input) {
    const base = DEFAULT_STATE();
    if (!input || typeof input !== 'object' || Array.isArray(input)) return base;
    const merged = { ...base, ...input };
    merged.budget = Math.max(0, Number(merged.budget) || 0);
    merged.expenses = Array.isArray(merged.expenses) ? merged.expenses : [];
    merged.subjects = Array.isArray(merged.subjects) ? merged.subjects : base.subjects;
    merged.lessonPayments = Array.isArray(merged.lessonPayments) ? merged.lessonPayments : [];
    merged.notes = Array.isArray(merged.notes) ? merged.notes : [];
    merged.subBudgets = { ...base.subBudgets, ...(merged.subBudgets || {}) };
    merged.notificationSettings = { ...base.notificationSettings, ...(merged.notificationSettings || {}) };
    merged.currency = 'ج.م';
    return merged;
  }

  async function initialize() {
    try {
      if (!window.APP_CONFIG?.supabaseUrl || !window.APP_CONFIG?.supabaseAnonKey || !window.supabase?.createClient) {
        throw new Error('إعدادات Supabase غير مكتملة. راجع ملف README وإعدادات Vercel.');
      }
      supabaseClient = window.supabase.createClient(window.APP_CONFIG.supabaseUrl, window.APP_CONFIG.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      $('signInButton').addEventListener('click', () => authenticate(false));
      $('signUpButton').addEventListener('click', () => authenticate(true));
      $('signOutButton').addEventListener('click', signOut);
      $('adminButton').addEventListener('click', openAdminPanel);
      $('closeAdminButton').addEventListener('click', () => $('adminModal').classList.add('hidden'));
      $('emailAlertToggle').addEventListener('change', changeEmailPreference);
      $('enablePushButton').addEventListener('click', enablePushNotifications);
      $('disablePushButton').addEventListener('click', disablePushNotifications);
      $('confirmYesBtn').addEventListener('click', async () => { closeModal('confirmModal'); if (onConfirmAction) await onConfirmAction(); onConfirmAction = null; });
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (session?.user) await activateSession(session.user);
      supabaseClient.auth.onAuthStateChange((_event, sessionNow) => {
        if (!sessionNow?.user) showAuth();
      });
    } catch (error) {
      setMessage('authMessage', error.message || 'تعذر تهيئة التطبيق.', true);
    }
  }

  async function authenticate(createAccount) {
    const email = $('authEmail').value.trim();
    const password = $('authPassword').value;
    if (!email || password.length < 8) return setMessage('authMessage', 'أدخل بريدًا صحيحًا وكلمة مرور من 8 أحرف على الأقل.', true);
    setMessage('authMessage', 'جارٍ الاتصال…');
    const result = createAccount
      ? await supabaseClient.auth.signUp({ email, password })
      : await supabaseClient.auth.signInWithPassword({ email, password });
    if (result.error) return setMessage('authMessage', result.error.message, true);
    if (!result.data.session) return setMessage('authMessage', 'تم إنشاء الحساب. افحص بريدك لتأكيده، ثم سجّل الدخول.');
    await activateSession(result.data.user);
  }

  async function activateSession(user) {
    currentUser = user;
    $('authGate').classList.add('hidden');
    $('appShell').classList.remove('hidden');
    $('appShell').classList.add('flex');
    setSync('جارٍ تحميل البيانات…');
    try {
      const { data, error } = await supabaseClient.from('app_data').select('state').eq('user_id', user.id).maybeSingle();
      if (error) throw error;
      if (data?.state) appState = normalizeState(data.state);
      else {
        appState = DEFAULT_STATE();
        await persistNow();
      }
      updateCurrencySymbols();
      renderAll();
      $('emailAlertToggle').checked = appState.notificationSettings.emailEnabled === true;
      await checkAdminButton();
      setSync('متزامن سحابيًا');
      void dispatchNotifications();
    } catch (error) {
      setSync('تعذر تحميل البيانات', true);
      alert(`تعذر تحميل بيانات حسابك من قاعدة البيانات: ${error.message}`);
    }
  }

  function showAuth() {
    currentUser = null;
    $('appShell').classList.add('hidden');
    $('appShell').classList.remove('flex');
    $('authGate').classList.remove('hidden');
  }
  async function signOut() { clearTimeout(saveTimer); await persistNow(); await saveQueue; await supabaseClient.auth.signOut(); appState = DEFAULT_STATE(); showAuth(); }

  function persistNow() {
    if (!currentUser) return Promise.resolve();
    const snapshot = JSON.parse(JSON.stringify(appState));
    const userId = currentUser.id;
    setSync('جارٍ الحفظ…');
    saveQueue = saveQueue.then(async () => {
      const { error } = await supabaseClient.from('app_data').upsert({ user_id: userId, state: snapshot, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) throw error;
      setSync('تم الحفظ سحابيًا');
      void dispatchNotifications();
    }).catch((error) => {
      setSync('فشل الحفظ — صدّر نسخة احتياطية', true);
      console.error('Cloud save failed', error);
    });
    return saveQueue;
  }
  function saveState() {
    updateDashboard();
    updateNotifications();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { persistNow(); }, 350);
  }
  function renderAll() {
    renderExpenses(); renderSubjects(); renderLessonPayments(); renderSubBudgets(); renderNotes();
    updateDashboard(); updateNotifications(); updateCurrencySymbols();
    generateReport();
  }
  function updateCurrencySymbols() { document.querySelectorAll('.currencySymbol').forEach((e) => e.textContent = 'ج.م'); }
  function updateDashboard() {
    const spent = totalExpenses() + totalLessons();
    if ($('totalBudgetDisplay')) $('totalBudgetDisplay').textContent = money(appState.budget);
    if ($('totalSpentDisplay')) $('totalSpentDisplay').textContent = money(spent);
    if ($('lessonsSpentDisplay')) $('lessonsSpentDisplay').textContent = money(totalLessons());
    if ($('remainingDisplay')) $('remainingDisplay').textContent = money(appState.budget - spent);
    const days = Math.max(1, new Date().getDate());
    if ($('dailyAvgDisplay')) $('dailyAvgDisplay').textContent = money(totalExpenses() / days);
    const leftDays = Math.max(1, new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate() - new Date().getDate() + 1);
    if ($('dailyAllowedDisplay')) $('dailyAllowedDisplay').textContent = money(Math.max(0, appState.budget - spent) / leftDays);
  }

  function renderExpenses() {
    const body = $('expensesTableBody'); if (!body) return;
    const category = $('filterCategory')?.value || 'ALL';
    const query = ($('searchExpenses')?.value || '').trim().toLowerCase();
    const rows = appState.expenses.filter((x) => (category === 'ALL' || x.category === category) && `${x.note || ''} ${x.category || ''}`.toLowerCase().includes(query)).sort((a,b) => (b.date || '').localeCompare(a.date || ''));
    body.innerHTML = rows.map((x) => `<tr class="border-b border-slate-100"><td class="p-3">${escapeHtml(x.date)}</td><td class="p-3">${escapeHtml(x.category)}</td><td class="p-3 font-bold">${money(x.amount)} ج.م</td><td class="p-3">${escapeHtml(x.note || '—')}</td><td class="p-3 text-center no-print"><button class="text-indigo-600 px-1" onclick="editExpense('${escapeHtml(x.id)}')">تعديل</button><button class="text-rose-600 px-1" onclick="deleteExpense('${escapeHtml(x.id)}')">حذف</button></td></tr>`).join('');
    if ($('noExpensesMessage')) $('noExpensesMessage').classList.toggle('hidden', rows.length !== 0);
  }
  function renderSubjects() {
    const wrap = $('subjectsContainer'); if (!wrap) return;
    wrap.innerHTML = appState.subjects.map((s) => `<article class="bg-white border border-slate-200 rounded-2xl p-4"><div class="flex justify-between gap-2"><div><h3 class="font-black">${escapeHtml(s.name)}</h3><p class="text-xs text-slate-500 mt-1">الاشتراك التقديري: ${money(s.estimatedFee)} ج.م</p><p class="text-xs text-slate-500">الحصص: ${Number(s.sessionsAttended || 0)}</p></div><div class="flex flex-col gap-1"><button class="text-indigo-600 text-xs" onclick="editSubject('${escapeHtml(s.id)}')">تعديل</button><button class="text-rose-600 text-xs" onclick="deleteSubject('${escapeHtml(s.id)}')">حذف</button></div></div><button class="mt-3 text-xs bg-indigo-50 text-indigo-700 px-3 py-1.5 rounded-lg" onclick="openSessionEditor('${escapeHtml(s.id)}')">تعديل عدد الحصص</button></article>`).join('');
    const select = $('lessonSubjectSelect'); if (select) select.innerHTML = appState.subjects.length ? appState.subjects.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('') : '<option value="">أضف مادة أولًا</option>';
  }
  function renderLessonPayments() {
    const body = $('lessonPaymentsTableBody'); if (!body) return;
    body.innerHTML = appState.lessonPayments.slice().sort((a,b) => (b.date||'').localeCompare(a.date||'')).map((p) => {
      const subject = appState.subjects.find((s) => s.id === p.subjectId)?.name || p.subjectName || 'مادة محذوفة';
      return `<tr class="border-b border-slate-100"><td class="p-3">${escapeHtml(p.date)}</td><td class="p-3">${escapeHtml(subject)}</td><td class="p-3">${escapeHtml(p.month)}</td><td class="p-3 font-bold">${money(p.amount)} ج.م</td><td class="p-3">${escapeHtml(p.teacher || '—')}</td><td class="p-3 text-center no-print"><button class="text-indigo-600" onclick="editLessonPayment('${escapeHtml(p.id)}')">تعديل</button> <button class="text-rose-600" onclick="deleteLessonPayment('${escapeHtml(p.id)}')">حذف</button></td></tr>`;
    }).join('');
  }
  function renderSubBudgets() {
    const wrap = $('subBudgetsContainer'); if (!wrap) return;
    wrap.innerHTML = CATEGORIES.map((c) => {
      const spent = appState.expenses.filter((x) => x.category === c).reduce((s,x) => s + Number(x.amount || 0),0);
      const limit = Number(appState.subBudgets[c] || 0);
      const pct = limit ? Math.min(100, Math.round(spent / limit * 100)) : 0;
      return `<article class="bg-slate-50 border border-slate-200 rounded-2xl p-4"><div class="flex justify-between items-center"><strong>${escapeHtml(c)}</strong><button class="text-xs text-teal-700 font-bold" onclick="openLimitModal('${escapeHtml(c)}')">تعديل الحد</button></div><p class="text-xs text-slate-500 mt-2">الإنفاق: ${money(spent)}${limit ? ` / ${money(limit)} ج.م` : ' ج.م'}</p><div class="h-2 bg-slate-200 rounded-full mt-2 overflow-hidden"><div class="h-full bg-teal-500" style="width:${pct}%"></div></div></article>`;
    }).join('');
  }
  function renderNotes() {
    const wrap = $('notesGrid'); if (!wrap) return;
    wrap.innerHTML = appState.notes.length ? appState.notes.map((n) => `<article class="bg-amber-50 border border-amber-100 rounded-2xl p-4"><div class="flex justify-between"><h3 class="font-bold">${escapeHtml(n.title)}</h3><button class="text-rose-600 text-xs" onclick="deleteNote('${escapeHtml(n.id)}')">حذف</button></div><p class="text-sm text-slate-600 mt-2 whitespace-pre-wrap">${escapeHtml(n.content || '')}</p>${n.date ? `<p class="text-xs text-amber-800 mt-3">تذكير: ${escapeHtml(n.date)}</p>` : ''}</article>`).join('') : '<p class="text-sm text-slate-400">لا توجد مذكرات حتى الآن.</p>';
  }

  function updateNotifications() {
    const list = [];
    const spent = totalExpenses() + totalLessons();
    if (appState.budget > 0 && spent > appState.budget) list.push({ text: `تم تجاوز الميزانية بمقدار ${money(spent - appState.budget)} ج.م.`, type: 'rose' });
    else if (appState.budget > 0 && spent >= appState.budget * 0.8) list.push({ text: `استهلكت ${Math.round(spent / appState.budget * 100)}٪ من الميزانية المحددة.`, type: 'amber' });
    for (const category of CATEGORIES) {
      const limit = Number(appState.subBudgets[category] || 0);
      const amount = appState.expenses.filter((x) => x.category === category).reduce((s,x) => s + Number(x.amount || 0),0);
      if (limit > 0 && amount >= limit) list.push({ text: `تم بلوغ حد تصنيف «${category}» أو تجاوزه (${money(amount)} من ${money(limit)} ج.م).`, type: 'rose' });
      else if (limit > 0 && amount >= limit * 0.8) list.push({ text: `اقترب الإنفاق في «${category}» من الحد (${money(amount)} من ${money(limit)} ج.م).`, type: 'amber' });
    }
    for (const note of appState.notes) if (note.date && note.date <= today()) list.push({ text: `تذكير ${note.date < today() ? 'متأخر' : 'اليوم'}: ${note.title}`, type: 'indigo' });
    const badge = $('notifBadge'); if (badge) { badge.textContent = String(list.length); badge.classList.toggle('hidden', list.length === 0); }
    const container = $('notificationsList'); if (container) container.innerHTML = list.length ? list.map((n) => `<div class="p-3 rounded-xl border ${n.type === 'rose' ? 'bg-rose-50 border-rose-100 text-rose-800' : n.type === 'amber' ? 'bg-amber-50 border-amber-100 text-amber-800' : 'bg-indigo-50 border-indigo-100 text-indigo-800'} text-sm">${escapeHtml(n.text)}</div>`).join('') : '<p class="text-sm text-slate-500 p-3">لا توجد تنبيهات حاليًا.</p>';
  }

  function renderReport(data = null) {
    const start = $('reportStartDate')?.value || '';
    const end = $('reportEndDate')?.value || '';
    const records = [];
    appState.expenses.forEach((x) => records.push({ date: x.date, type: 'مصروف', category: x.category, details: x.note || '', amount: Number(x.amount || 0) }));
    appState.lessonPayments.forEach((x) => records.push({ date: x.date, type: 'درس', category: appState.subjects.find((s) => s.id === x.subjectId)?.name || 'دروس', details: `${x.month || ''} ${x.teacher || ''}`.trim(), amount: Number(x.amount || 0), lesson: true }));
    reportRows = records.filter((x) => (!start || x.date >= start) && (!end || x.date <= end)).sort((a,b) => (a.date || '').localeCompare(b.date || ''));
    const spent = reportRows.reduce((s,x) => s + x.amount,0);
    const lesson = reportRows.filter((x) => x.lesson).reduce((s,x) => s + x.amount,0);
    const transitFood = reportRows.filter((x) => ['مواصلات','أكل'].includes(x.category)).reduce((s,x) => s + x.amount,0);
    $('reportTotalSpent').textContent = money(spent); $('reportLessonsSpent').textContent = money(lesson); $('reportTransitFoodSpent').textContent = money(transitFood); $('reportCount').textContent = String(reportRows.length);
    $('reportTableBody').innerHTML = reportRows.map((x) => `<tr><td class="p-2.5 border">${escapeHtml(x.date)}</td><td class="p-2.5 border">${escapeHtml(x.type)}</td><td class="p-2.5 border">${escapeHtml(x.category)}</td><td class="p-2.5 border">${escapeHtml(x.details)}</td><td class="p-2.5 border">${money(x.amount)} ج.م</td></tr>`).join('');
    $('printCurrentDate').textContent = new Date().toLocaleDateString('ar-EG');
    $('printPeriodText').textContent = start || end ? `من ${start || 'البداية'} إلى ${end || 'اليوم'}` : 'تقرير شامل لجميع الأوقات المسجلة';
    drawCharts();
  }
  function drawCharts() {
    if (!window.Chart) return;
    const byCat = Object.fromEntries(CATEGORIES.map((c) => [c, reportRows.filter((x) => x.category === c).reduce((s,x) => s + x.amount,0)]));
    if (categoryChartInstance) categoryChartInstance.destroy();
    categoryChartInstance = new Chart($('categoryChart'), { type: 'doughnut', data: { labels: Object.keys(byCat), datasets: [{ data: Object.values(byCat), backgroundColor: ['#0f766e','#f59e0b','#6366f1','#e11d48','#64748b'] }] }, options: { responsive: true, maintainAspectRatio: false } });
    if (cumulativeChartInstance) cumulativeChartInstance.destroy();
    let sum = 0; const labels = reportRows.map((x) => x.date); const values = reportRows.map((x) => { sum += x.amount; return sum; });
    cumulativeChartInstance = new Chart($('cumulativeChart'), { type: 'line', data: { labels, datasets: [{ label: 'إجمالي الإنفاق', data: values, borderColor: '#4f46e5', tension: .25 }] }, options: { responsive: true, maintainAspectRatio: false } });
  }

  function openModal(id) { const el = $(id); if (el) el.classList.remove('hidden'); }
  function closeModal(id) { const el = $(id); if (el) el.classList.add('hidden'); }
  function askConfirm(title, message, action) { $('confirmTitle').textContent = title; $('confirmMessage').textContent = message; onConfirmAction = action; openModal('confirmModal'); }
  function switchTab(tab) {
    document.querySelectorAll('.tab-content').forEach((el) => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach((el) => { el.classList.remove('bg-emerald-600','text-white','shadow-sm'); el.classList.add('text-slate-600'); });
    $(`content-${tab}`)?.classList.remove('hidden');
    const btn = $(`tab-${tab}`); if (btn) { btn.classList.add('bg-emerald-600','text-white','shadow-sm'); btn.classList.remove('text-slate-600'); }
    if (tab === 'reports') renderReport();
  }
  function openAddExpenseModal() { $('expenseEditId').value=''; $('expenseAmount').value=''; $('expenseNote').value=''; $('expenseDate').value=today(); $('expenseModalTitle').innerHTML='<i class="fa-solid fa-cart-plus text-emerald-600"></i> تسجيل مصروف جديد'; openModal('addExpenseModal'); }
  function editExpense(id) { const x=appState.expenses.find((a)=>a.id===id); if(!x)return; $('expenseEditId').value=id; $('expenseAmount').value=x.amount; $('expenseCategory').value=x.category; $('expenseDate').value=x.date; $('expenseNote').value=x.note||''; openModal('addExpenseModal'); }
  async function handleSaveExpense(e) { e.preventDefault(); const id=$('expenseEditId').value; const item={id:id||uid(),amount:Number($('expenseAmount').value),category:$('expenseCategory').value,date:$('expenseDate').value,note:$('expenseNote').value.trim()}; if(!item.amount||item.amount<=0||!item.date)return alert('تحقق من المبلغ والتاريخ.'); appState.expenses=id?appState.expenses.map((x)=>x.id===id?item:x):[item,...appState.expenses]; closeModal('addExpenseModal'); renderAll(); saveState(); }
  function deleteExpense(id) { askConfirm('حذف المصروف','هل تريد حذف هذا المصروف؟',()=>{appState.expenses=appState.expenses.filter((x)=>x.id!==id);renderAll();saveState();}); }
  function openSetBudgetModal(){ $('budgetAmountInput').value=appState.budget||'';openModal('setBudgetModal'); }
  function handleSaveBudget(e){e.preventDefault();appState.budget=Number($('budgetAmountInput').value)||0;closeModal('setBudgetModal');renderAll();saveState();}
  function openAddSubjectModal(id=''){ $('subjectEditId').value=id; const s=appState.subjects.find((x)=>x.id===id); $('subjectNameInput').value=s?.name||''; $('subjectFeeInput').value=s?.estimatedFee||''; openModal('addSubjectModal'); }
  function handleAddSubject(e){e.preventDefault();const id=$('subjectEditId').value;const item={id:id||uid(),name:$('subjectNameInput').value.trim(),estimatedFee:Number($('subjectFeeInput').value)||0,sessionsAttended:appState.subjects.find((x)=>x.id===id)?.sessionsAttended||0};if(!item.name)return;appState.subjects=id?appState.subjects.map((x)=>x.id===id?item:x):[...appState.subjects,item];closeModal('addSubjectModal');renderAll();saveState();}
  function editSubject(id){openAddSubjectModal(id);}
  function deleteSubject(id){askConfirm('حذف المادة','حذف المادة لا يمسح الدفعات السابقة المرتبطة بها.',()=>{appState.subjects=appState.subjects.filter((x)=>x.id!==id);renderAll();saveState();});}
  function openSessionEditor(id){const s=appState.subjects.find((x)=>x.id===id);if(!s)return;$('editSessionSubjectId').value=id;$('sessionCountInput').value=Number(s.sessionsAttended)||0;$('editSessionTitle').textContent=`تعديل حصص ${s.name}`;openModal('editSessionModal');}
  function handleSaveSessionCount(e){e.preventDefault();const id=$('editSessionSubjectId').value;appState.subjects=appState.subjects.map((s)=>s.id===id?{...s,sessionsAttended:Math.max(0,Number($('sessionCountInput').value)||0)}:s);closeModal('editSessionModal');renderAll();saveState();}
  function openAddLessonPaymentModal(){ $('lessonPaymentEditId').value='';$('lessonAmount').value='';$('lessonMonth').value='';$('lessonTeacher').value='';$('lessonDate').value=today();renderSubjects();openModal('addLessonPaymentModal'); }
  function editLessonPayment(id){const p=appState.lessonPayments.find((x)=>x.id===id);if(!p)return;$('lessonPaymentEditId').value=id;$('lessonSubjectSelect').value=p.subjectId;$('lessonAmount').value=p.amount;$('lessonMonth').value=p.month;$('lessonTeacher').value=p.teacher||'';$('lessonDate').value=p.date;openModal('addLessonPaymentModal');}
  function handleSaveLessonPayment(e){e.preventDefault();const id=$('lessonPaymentEditId').value;const item={id:id||uid(),subjectId:$('lessonSubjectSelect').value,amount:Number($('lessonAmount').value),month:$('lessonMonth').value.trim(),teacher:$('lessonTeacher').value.trim(),date:$('lessonDate').value};if(!item.subjectId||item.amount<=0||!item.date)return alert('تحقق من المادة والمبلغ والتاريخ.');appState.lessonPayments=id?appState.lessonPayments.map((x)=>x.id===id?item:x):[item,...appState.lessonPayments];closeModal('addLessonPaymentModal');renderAll();saveState();}
  function deleteLessonPayment(id){askConfirm('حذف دفعة','هل تريد حذف هذه الدفعة؟',()=>{appState.lessonPayments=appState.lessonPayments.filter((x)=>x.id!==id);renderAll();saveState();});}
  function openLimitModal(category){$('limitCategoryName').value=category;$('limitCategoryTitle').textContent=`تعيين حد ${category}`;$('limitAmountInput').value=appState.subBudgets[category]||'';openModal('setLimitModal');}
  function handleSaveSubBudget(e){e.preventDefault();const c=$('limitCategoryName').value;appState.subBudgets[c]=Number($('limitAmountInput').value)||0;closeModal('setLimitModal');renderAll();saveState();}
  function handleAddNote(e){e.preventDefault();appState.notes.unshift({id:uid(),title:$('noteTitle').value.trim(),content:$('noteContent').value.trim(),date:$('noteDate').value||''});e.target.reset();closeModal('addNoteModal');renderAll();saveState();}
  function deleteNote(id){askConfirm('حذف المذكرة','هل تريد حذف هذه المذكرة؟',()=>{appState.notes=appState.notes.filter((x)=>x.id!==id);renderAll();saveState();});}
  function generateReport(){renderReport();}
  function resetReportDates(){ $('reportStartDate').value='';$('reportEndDate').value='';renderReport(); }
  function triggerPrint(){window.print();}
  function exportCSV(){const rows=[['التاريخ','النوع','التصنيف','التفاصيل','المبلغ'],...reportRows.map((x)=>[x.date,x.type,x.category,x.details,x.amount])];const csv='\ufeff'+rows.map((r)=>r.map((v)=>`"${String(v??'').replaceAll('"','""')}"`).join(',')).join('\r\n');download(new Blob([csv],{type:'text/csv;charset=utf-8'}),`budget-report-${today()}.csv`);}
  function download(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function exportJSONData(){download(new Blob([JSON.stringify(appState,null,2)],{type:'application/json'}),`budget-backup-${today()}.json`);}
  async function importJSONData(event){const file=event.target.files?.[0];if(!file)return;try{const raw=JSON.parse(await file.text());appState=normalizeState(raw);renderAll();saveState();alert('تم استيراد النسخة. انتظر ظهور «تم الحفظ سحابيًا» قبل إغلاق الصفحة.');}catch(e){alert('تعذر استيراد الملف: صيغة JSON غير صحيحة.');}finally{event.target.value='';}}
  function loadDemoSampleData(){askConfirm('تحميل عينة','ستُستبدل بيانات الحساب الحالية بعينة توضيحية. هل تتابع؟',()=>{appState=DEFAULT_STATE();appState.budget=5000;appState.expenses=[{id:uid(),date:today(),category:'مواصلات',amount:75,note:'عينة مواصلات'},{id:uid(),date:today(),category:'أكل',amount:120,note:'عينة طعام'}];renderAll();saveState();});}
  function resetAllDataData(){askConfirm('تصفير البيانات','سيؤدي ذلك إلى حذف جميع بياناتك المحفوظة لهذا الحساب. هل تريد المتابعة؟',()=>{appState=DEFAULT_STATE();renderAll();saveState();});}

  async function changeEmailPreference(event) {
    const enabled = event.target.checked;
    if (enabled && !window.APP_CONFIG?.emailConfigured) {
      event.target.checked = false;
      $('notificationSettingsMessage').textContent = 'إرسال البريد غير مهيأ بعد؛ أضف إعدادات Resend في Vercel أولًا.';
      return;
    }
    appState.notificationSettings.emailEnabled = enabled;
    $('notificationSettingsMessage').textContent = enabled ? 'تم تفعيل البريد. ستُرسل تنبيهات عامة عند تحقق شرط جديد.' : 'تم إيقاف تنبيهات البريد.';
    saveState();
  }

  function base64UrlToBytes(value) {
    const padded = value + '='.repeat((4 - value.length % 4) % 4);
    const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function enablePushNotifications() {
    const status = $('notificationSettingsMessage');
    try {
      if (!window.APP_CONFIG?.pushConfigured || !window.APP_CONFIG?.vapidPublicKey) throw new Error('إشعارات المتصفح غير مهيأة على Vercel بعد.');
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('هذا المتصفح لا يدعم Web Push؛ استخدم Chrome أو Edge أو Firefox عبر HTTPS.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('لم يتم منح إذن الإشعارات. يمكنك تفعيله من إعدادات المتصفح.');
      const registration = await navigator.serviceWorker.register('/sw.js');
      const ready = await navigator.serviceWorker.ready;
      let subscription = await ready.pushManager.getSubscription();
      if (!subscription) subscription = await ready.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(window.APP_CONFIG.vapidPublicKey) });
      const json = subscription.toJSON();
      const { error } = await supabaseClient.from('push_subscriptions').upsert({ user_id: currentUser.id, endpoint: subscription.endpoint, subscription: json }, { onConflict: 'endpoint' });
      if (error) throw error;
      status.textContent = 'تم تفعيل إشعارات المتصفح على هذا الجهاز.';
      void dispatchNotifications();
    } catch (error) { status.textContent = error.message || 'تعذر تفعيل الإشعارات.'; }
  }

  async function disablePushNotifications() {
    const status = $('notificationSettingsMessage');
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        const { error } = await supabaseClient.from('push_subscriptions').delete().eq('user_id', currentUser.id).eq('endpoint', endpoint);
        if (error) throw error;
      }
      status.textContent = 'تم إيقاف إشعارات هذا الجهاز.';
    } catch (error) { status.textContent = error.message || 'تعذر إيقاف الإشعارات.'; }
  }

  async function dispatchNotifications() {
    if (!currentUser || document.visibilityState === 'prerender' || !window.APP_CONFIG?.notificationApiConfigured) return;
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (!session?.access_token) return;
      const response = await fetch('/api/notify', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) console.warn('Notification dispatch is not ready:', await response.text());
    } catch (error) { console.warn('Notification dispatch failed:', error); }
  }

  async function checkAdminButton() {
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const response = await fetch('/api/admin-data?mode=status', { headers: { Authorization: `Bearer ${session.access_token}` } });
      const result = await response.json();
      $('adminButton').classList.toggle('hidden', !response.ok || !result.isAdmin);
    } catch (_) { $('adminButton').classList.add('hidden'); }
  }

  async function openAdminPanel(){
    $('adminModal').classList.remove('hidden'); $('adminModal').classList.add('flex'); $('adminMessage').textContent='جارٍ التحقق وتحميل السجلات…'; $('adminUsers').innerHTML='';
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const response = await fetch('/api/admin-data', { headers: { Authorization: `Bearer ${session.access_token}` } });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error || 'رفض الخادم الطلب.');
      $('adminMessage').textContent=`عدد الحسابات: ${payload.users.length} — تم تسجيل عملية الاطلاع.`;
      $('adminUsers').innerHTML=payload.users.map((u)=>`<article class="border border-slate-200 rounded-xl p-3"><div class="font-bold">${escapeHtml(u.email || 'بريد غير متاح')}</div><div class="text-xs text-slate-500 mt-1">معرّف: ${escapeHtml(u.user_id)} — آخر تحديث: ${escapeHtml(u.updated_at || 'لا توجد بيانات')}</div><details class="mt-2"><summary class="cursor-pointer text-sm text-indigo-700">عرض بيانات التطبيق</summary><pre class="text-xs whitespace-pre-wrap overflow-auto max-h-72 bg-slate-50 p-3 mt-2 rounded-lg">${escapeHtml(JSON.stringify(u.state || {},null,2))}</pre></details></article>`).join('') || '<p>لا توجد حسابات مسجلة.</p>';
    } catch(error) { $('adminMessage').textContent=error.message; }
  }

  // Keep legacy inline handlers global for the supplied HTML.
  Object.assign(window,{openModal,closeModal,switchTab,openAddExpenseModal,handleSaveExpense,editExpense,deleteExpense,openSetBudgetModal,handleSaveBudget,openAddSubjectModal,handleAddSubject,editSubject,deleteSubject,openSessionEditor,handleSaveSessionCount,openAddLessonPaymentModal,handleSaveLessonPayment,editLessonPayment,deleteLessonPayment,openLimitModal,handleSaveSubBudget,handleAddNote,deleteNote,renderExpenses,generateReport,resetReportDates,triggerPrint,exportCSV,exportJSONData,importJSONData,loadDemoSampleData,resetAllDataData});
  initialize();
})();