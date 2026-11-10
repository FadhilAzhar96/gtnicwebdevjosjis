// Laundry Akbar - logika frontend (terhubung ke REST API)
let currentUser = null;
let currentQrisOrderId = null;
let token = localStorage.getItem('laundry_akbar_token');
let pollTimer = null;

const PRICING = { Reguler: 6000, Kering: 12000, Basah: 4000, Express: 10000 };
let PICKUP_FEE = 5000;

let orders = [];
let notifications = [];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = iso => new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
        ...opts,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        if (res.status === 401 && token && !path.startsWith('/auth/')) {
            resetSession();
            navigateTo('landing');
            toast('Sesi berakhir, silakan masuk kembali.');
        }
        const err = new Error(data.error || 'Terjadi kesalahan pada server.');
        err.status = res.status;
        throw err;
    }
    return data;
}

window.addEventListener('DOMContentLoaded', async () => {
    calculateOrderTotal();
    renderOrders();
    renderNotifications();
    highlightSelectedRadio();
    try {
        const p = await api('/pricing');
        Object.assign(PRICING, p.prices);
        PICKUP_FEE = p.pickupFee;
        calculateOrderTotal();
    } catch (e) { /* pakai harga bawaan */ }
    restoreSession();
});

async function restoreSession() {
    if (!token) return;
    try {
        const { user } = await api('/auth/me');
        await startSession(user);
    } catch (e) {
        token = null;
        localStorage.removeItem('laundry_akbar_token');
    }
}

async function startSession(user) {
    currentUser = user;
    updateHeaderUI(user.role === 'admin' ? 'Admin (Administrator)' : user.username);
    await refreshData();
    clearInterval(pollTimer);
    pollTimer = setInterval(() => refreshData(), 15000);
    navigateTo(user.role === 'admin' ? 'admin' : 'dashboard');
}

function resetSession() {
    token = null;
    localStorage.removeItem('laundry_akbar_token');
    currentUser = null;
    orders = [];
    notifications = [];
    clearInterval(pollTimer);
    document.getElementById('guestButtons').classList.remove('hidden');
    document.getElementById('userMenu').classList.add('hidden');
    document.getElementById('userMenu').classList.remove('flex');
    renderOrders();
    renderNotifications();
}

async function refreshData(manual = false) {
    if (!currentUser) return;
    const active = document.activeElement;
    if (!manual && active && active.closest && active.closest('#adminOrdersTableBody')) return;
    try {
        const [o, n] = await Promise.all([api('/orders'), api('/notifications')]);
        orders = o.orders;
        notifications = n.notifications.map(x => ({ ...x, time: fmtTime(x.createdAt) }));
        renderOrders();
        renderAdminOrders();
        renderNotifications();
        if (manual) toast('Data berhasil diperbarui');
    } catch (e) { if (manual) toast(e.message); }
}

async function markAllNotificationsRead() {
    try {
        await api('/notifications/read', { method: 'POST' });
        notifications = notifications.map(n => ({ ...n, read: true }));
        renderNotifications();
    } catch (e) { toast(e.message); }
}

async function handleLoginSubmit(e) {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    try {
        const d = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
        token = d.token;
        localStorage.setItem('laundry_akbar_token', token);
        closeAuthModal();
        toast(d.user.role === 'admin' ? 'Berhasil login sebagai Administrator!' : `Selamat datang kembali, ${d.user.username}!`);
        await startSession(d.user);
    } catch (err) {
        toast(err.message);
        if (err.status === 404) switchAuthView('register');
    }
}

async function handleRegisterSubmit(e) {
    e.preventDefault();
    const username = document.getElementById('regUsername').value.trim();
    const password = document.getElementById('regPassword').value;
    const confirmPass = document.getElementById('regConfirmPassword').value;
    if (password !== confirmPass) {
        toast('Kata sandi konfirmasi tidak cocok!');
        return;
    }
    try {
        const d = await api('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) });
        token = d.token;
        localStorage.setItem('laundry_akbar_token', token);
        closeAuthModal();
        toast(`Akun berhasil dibuat. Selamat datang, ${d.user.username}!`);
        await startSession(d.user);
    } catch (err) {
        toast(err.message);
        if (err.status === 409) switchAuthView('login');
    }
}

async function handleLogout() {
    try { if (token) await api('/auth/logout', { method: 'POST' }); } catch (e) { /* abaikan */ }
    resetSession();
    navigateTo('landing');
    toast('Anda telah keluar akun.');
}

async function handleOrderSubmit(e) {
    e.preventDefault();
    const body = {
        service: document.querySelector('input[name="serviceType"]:checked').value,
        weight: parseFloat(document.getElementById('orderWeight').value),
        pickup: document.getElementById('pickupOption').value,
        address: document.getElementById('orderAddress').value
    };
    try {
        const order = await api('/orders', { method: 'POST', body: JSON.stringify(body) });
        orders.unshift(order);
        renderOrders();
        switchDashboardTab('status');
        openQrisModal(order.id);
        refreshData();
    } catch (err) { toast(err.message); }
}

async function confirmQrisPayment() {
    if (!currentQrisOrderId) return;
    try {
        await api(`/orders/${currentQrisOrderId}/pay`, { method: 'POST' });
        toast('Pembayaran QRIS berhasil dikonfirmasi!');
        closeQrisModal();
        await refreshData(true);
    } catch (err) { toast(err.message); }
}

async function updateOrderStatus(orderId, newStatus) {
    try {
        await api(`/orders/${orderId}/status`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
        toast(`Status ${orderId} diubah menjadi "${newStatus}"`);
    } catch (err) { toast(err.message); }
    await refreshData(true);
}

async function handleContactSubmit(e) {
    e.preventDefault();
    const f = e.target.querySelectorAll('input, textarea');
    try {
        await api('/contact', { method: 'POST', body: JSON.stringify({ name: f[0].value, phone: f[1].value, message: f[2].value }) });
        toast('Pesan Anda berhasil terkirim. Admin kami akan menghubungi Anda!');
        e.target.reset();
    } catch (err) { toast(err.message); }
}


function renderNotifications() {
    const list = document.getElementById('notifList');
    const badge = document.getElementById('notifBadge');
    if (!list || !badge) return;

    const unreadCount = notifications.filter(n => !n.read).length;
    if (unreadCount > 0) {
        badge.innerText = unreadCount;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }

    if (notifications.length === 0) {
        list.innerHTML = '<div class="p-4 text-center text-xs text-gray-400">Belum ada notifikasi</div>';
        return;
    }

    list.innerHTML = notifications.map(n => `
        <div class="px-4 py-3 text-xs ${n.read ? 'bg-white text-gray-500' : 'bg-emerald-50/60 text-gray-800 font-semibold'}">
            <p>${esc(n.message)}</p>
            <span class="text-[10px] text-gray-400 block mt-1">${n.time}</span>
        </div>
    `).join('');
}

function toggleNotificationDropdown() {
    document.getElementById('notifDropdown').classList.toggle('hidden');
    const userDropdown = document.getElementById('userDropdown');
    if (userDropdown) userDropdown.classList.add('hidden');
}

function toggleUserDropdown(forceState) {
    const dropdown = document.getElementById('userDropdown');
    if (!dropdown) return;
    if (typeof forceState === 'boolean') {
        dropdown.classList.toggle('hidden', !forceState);
    } else {
        dropdown.classList.toggle('hidden');
    }
    const notifDropdown = document.getElementById('notifDropdown');
    if (notifDropdown) notifDropdown.classList.add('hidden');
}

document.addEventListener('click', (e) => {
    const userContainer = document.getElementById('userDropdownContainer');
    const userDropdown = document.getElementById('userDropdown');
    if (userContainer && userDropdown && !userContainer.contains(e.target)) {
        userDropdown.classList.add('hidden');
    }
});

function handleLogoClick() {
    if (currentUser && currentUser.role === 'admin') {
        navigateTo('admin');
    } else {
        navigateTo('landing');
    }
}

function navigateTo(view) {
    document.getElementById('landingView').classList.add('hidden');
    document.getElementById('dashboardView').classList.add('hidden');
    document.getElementById('adminView').classList.add('hidden');

    if (view === 'dashboard') {
        document.getElementById('dashboardView').classList.remove('hidden');
    } else if (view === 'admin') {
        document.getElementById('adminView').classList.remove('hidden');
        renderAdminOrders();
    } else {
        document.getElementById('landingView').classList.remove('hidden');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showMainView() {
    if (!currentUser) {
        openAuthModal('login');
        toast('Silakan masuk terlebih dahulu');
        return;
    }
    navigateTo(currentUser.role === 'admin' ? 'admin' : 'dashboard');
}

function switchDashboardTab(tabName) {
    ['pesan', 'status', 'riwayat'].forEach(t => {
        const content = document.getElementById(`tab${capitalize(t)}Content`);
        const btn = document.getElementById(`btnTab${capitalize(t)}`);
        if (t === tabName) {
            content.classList.remove('hidden');
            btn.classList.add('bg-white', 'text-brandDarkText', 'shadow');
            btn.classList.remove('text-white', 'hover:bg-white/10');
        } else {
            content.classList.add('hidden');
            btn.classList.remove('bg-white', 'text-brandDarkText', 'shadow');
            btn.classList.add('text-white', 'hover:bg-white/10');
        }
    });
}

function openAuthModal(mode = 'login') {
    document.getElementById('authModal').classList.remove('hidden');
    switchAuthView(mode);
}

function closeAuthModal() {
    document.getElementById('authModal').classList.add('hidden');
}

function switchAuthView(mode) {
    const loginCard = document.getElementById('loginCard');
    const registerCard = document.getElementById('registerCard');
    if (mode === 'login') {
        loginCard.classList.remove('hidden');
        registerCard.classList.add('hidden');
    } else {
        loginCard.classList.add('hidden');
        registerCard.classList.remove('hidden');
    }
}

function updateHeaderUI(name) {
    document.getElementById('userNameDisplay').innerText = name;
    document.getElementById('userAvatar').innerText = name.charAt(0).toUpperCase();
    document.getElementById('guestButtons').classList.add('hidden');
    document.getElementById('userMenu').classList.remove('hidden');
    document.getElementById('userMenu').classList.add('flex');
}

function handleStartOrder() {
    if (!currentUser) openAuthModal('login');
    else if (currentUser.role === 'admin') navigateTo('admin');
    else { navigateTo('dashboard'); switchDashboardTab('pesan'); }
}

function handleServiceSelect(serviceType) {
    const radio = document.querySelector(`input[name="serviceType"][value="${serviceType}"]`);
    if (radio) radio.checked = true;
    calculateOrderTotal();
    handleStartOrder();
}

function calculateOrderTotal() {
    const selectedService = document.querySelector('input[name="serviceType"]:checked')?.value || 'Reguler';
    const weight = parseFloat(document.getElementById('orderWeight').value) || 1;
    const pickup = document.getElementById('pickupOption').value;
    const total = (PRICING[selectedService] * weight) + (pickup === 'antar-jemput' ? PICKUP_FEE : 0);
    document.getElementById('calculatedPriceDisplay').innerText = `Rp ${total.toLocaleString('id-ID')}`;
    highlightSelectedRadio();
}

function highlightSelectedRadio() {
    ['Reguler', 'Kering', 'Basah', 'Express'].forEach(s => {
        const label = document.getElementById(`lbl-${s}`);
        if (!label) return;
        if (label.querySelector('input').checked) {
            label.classList.add('border-brandMint', 'bg-emerald-50');
            label.classList.remove('border-gray-200');
        } else {
            label.classList.remove('border-brandMint', 'bg-emerald-50');
            label.classList.add('border-gray-200');
        }
    });
}

function openQrisModal(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;
    currentQrisOrderId = orderId;
    document.getElementById('qrisAmountDisplay').innerText = `Rp ${order.totalPrice.toLocaleString('id-ID')}`;
    
    const badge = document.getElementById('qrisStatusBadge');
    const btn = document.getElementById('qrisConfirmBtn');
    if (order.paymentStatus === 'Lunas') {
        badge.className = 'px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700';
        badge.innerText = 'Lunas';
        btn.classList.add('hidden');
    } else {
        badge.className = 'px-3 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-700';
        badge.innerText = 'Menunggu Pembayaran';
        btn.classList.remove('hidden');
    }
    document.getElementById('qrisModal').classList.remove('hidden');
}

function closeQrisModal() {
    document.getElementById('qrisModal').classList.add('hidden');
    currentQrisOrderId = null;
}

function renderOrders() {
    const activeList = document.getElementById('activeOrdersList');
    const historyBody = document.getElementById('historyTableBody');
    if (!activeList || !historyBody) return;

    activeList.innerHTML = '';
    historyBody.innerHTML = '';

    const activeOrders = orders.filter(o => o.status !== 'Selesai');
    document.getElementById('activeOrdersBadge').innerText = `${activeOrders.length} Pesanan`;

    if (activeOrders.length === 0) {
        activeList.innerHTML = `<div class="bg-white p-8 rounded-3xl text-center text-gray-400"><i class="fa-solid fa-box-open text-4xl mb-2"></i><p>Belum ada pesanan aktif saat ini.</p></div>`;
    } else {
        activeOrders.forEach(o => {
            const card = document.createElement('div');
            card.className = "bg-white p-6 rounded-3xl shadow-sm border border-gray-100 flex flex-col md:flex-row justify-between md:items-center gap-4";
            card.innerHTML = `
                <div class="space-y-1">
                    <div class="flex items-center space-x-3">
                        <span class="font-extrabold text-gray-900">${o.id}</span>
                        <span class="text-xs bg-emerald-100 text-emerald-800 font-bold px-2.5 py-0.5 rounded-full">${o.service}</span>
                        <span class="text-xs font-bold px-2.5 py-0.5 rounded-full ${o.paymentStatus === 'Lunas' ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'}">${o.paymentStatus || 'Menunggu Pembayaran'}</span>
                    </div>
                    <p class="text-xs text-gray-500"><i class="fa-solid fa-weight-hanging mr-1"></i> ${o.weight} kg &bull; ${o.pickup === 'antar-jemput' ? 'Antar Jemput Kurir' : 'Antar Mandiri'}</p>
                    <p class="text-xs text-gray-500"><i class="fa-solid fa-location-dot mr-1"></i> ${esc(o.address)}</p>
                </div>
                <div class="flex flex-col md:items-end justify-between space-y-2">
                    <span class="text-lg font-bold text-brandMintDark">Rp ${o.totalPrice.toLocaleString('id-ID')}</span>
                    <div class="flex items-center space-x-2">
                        ${o.paymentStatus !== 'Lunas' ? `<button onclick="openQrisModal('${o.id}')" class="text-xs font-bold bg-brandMint text-white px-3 py-1 rounded-full hover:bg-brandMintDark transition">Bayar QRIS</button>` : ''}
                        <span class="w-3 h-3 rounded-full bg-amber-400 animate-pulse"></span>
                        <span class="text-xs font-semibold text-gray-700 bg-amber-50 border border-amber-200 px-3 py-1 rounded-full">${o.status}</span>
                    </div>
                </div>
            `;
            activeList.appendChild(card);
        });
    }

    orders.forEach(o => {
        const tr = document.createElement('tr');
        tr.className = "hover:bg-gray-50 transition";
        tr.innerHTML = `
            <td class="py-4 px-6 font-bold text-gray-900">${o.id}</td>
            <td class="py-4 px-6 text-gray-500 text-xs">${o.date}</td>
            <td class="py-4 px-6 font-semibold">${o.service}</td>
            <td class="py-4 px-6 text-gray-600">${o.weight} kg</td>
            <td class="py-4 px-6 font-bold text-emerald-600">Rp ${o.totalPrice.toLocaleString('id-ID')}</td>
            <td class="py-4 px-6">
                <span class="px-3 py-1 rounded-full text-xs font-bold ${o.status === 'Selesai' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}">
                    ${o.status}
                </span>
            </td>
        `;
        historyBody.appendChild(tr);
    });
}

function renderAdminOrders() {
    const adminTableBody = document.getElementById('adminOrdersTableBody');
    if (!adminTableBody) return;
    adminTableBody.innerHTML = '';

    let totalRev = 0;
    let activeCount = 0;

    orders.forEach(o => {
        if (o.paymentStatus === 'Lunas') totalRev += o.totalPrice;
        if (o.status !== 'Selesai') activeCount++;

        const tr = document.createElement('tr');
        tr.className = "hover:bg-gray-50 transition";
        tr.innerHTML = `
            <td class="py-4 px-4 font-bold text-gray-900">${o.id}</td>
            <td class="py-4 px-4 text-gray-700 font-semibold">${esc(o.customerName || 'Pelanggan')}</td>
            <td class="py-4 px-4"><span class="px-2.5 py-1 bg-emerald-50 text-emerald-700 rounded-lg text-xs font-bold">${o.service}</span></td>
            <td class="py-4 px-4 text-gray-600">${o.weight} kg</td>
            <td class="py-4 px-4 font-bold text-gray-900">Rp ${o.totalPrice.toLocaleString('id-ID')}</td>
            <td class="py-4 px-4 text-xs text-gray-500 max-w-xs truncate">${esc(o.address)}</td>
            <td class="py-4 px-4">
                <select onchange="updateOrderStatus('${o.id}', this.value)" class="text-xs font-semibold px-3 py-1.5 rounded-xl border border-gray-200 bg-white focus:ring-2 focus:ring-brandMint outline-none">
                    <option value="Menunggu" ${o.status === 'Menunggu' ? 'selected' : ''}>Menunggu</option>
                    <option value="Diproses" ${o.status === 'Diproses' ? 'selected' : ''}>Diproses</option>
                    <option value="Selesai" ${o.status === 'Selesai' ? 'selected' : ''}>Selesai</option>
                    <option value="Diambil" ${o.status === 'Diambil' ? 'selected' : ''}>Diambil</option>
                </select>
            </td>
        `;
        adminTableBody.appendChild(tr);
    });

    document.getElementById('adminTotalOrders').innerText = orders.length;
    document.getElementById('adminActiveOrders').innerText = activeCount;
    document.getElementById('adminTotalRevenue').innerText = `Rp ${totalRev.toLocaleString('id-ID')}`;
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function toast(msg) {
    const toastEl = document.getElementById('toastNotification');
    document.getElementById('toastMessage').innerText = msg;
    toastEl.classList.remove('translate-y-20', 'opacity-0');
    setTimeout(() => toastEl.classList.add('translate-y-20', 'opacity-0'), 3000);
}
