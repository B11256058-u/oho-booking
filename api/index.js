const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const serviceAccount = require("./serviceAccountKey.json");
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

// [管理員登入]
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === '1234') {
        res.json({ success: true, token: 'hoho-admin-secure-token' });
    } else {
        res.status(401).json({ success: false, message: '帳號或密碼錯誤' });
    }
});

// [Dashboard 統計資料]
app.get('/api/admin/dashboard', async(req, res) => {
    try {
        const ordersSnapshot = await db.collection('orders').get();

        const monthlyOrders = {};
        const monthlyRevenue = {};

        ordersSnapshot.forEach(doc => {
            const order = doc.data();

            if (!order.createdAt) return;

            const date = new Date(order.createdAt);
            if (isNaN(date.getTime())) return;

            const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

            monthlyOrders[monthKey] = (monthlyOrders[monthKey] || 0) + 1;
            monthlyRevenue[monthKey] = (monthlyRevenue[monthKey] || 0) + (parseInt(order.totalPrice) || 0);
        });

        const labels = Object.keys(monthlyOrders).sort();

        res.json({
            success: true,
            labels,
            orders: labels.map(key => monthlyOrders[key]),
            revenue: labels.map(key => monthlyRevenue[key]),
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ success: false, message: 'Dashboard 載入失敗' });
    }
});

// [房型可用性檢查] - 支援「日期區間維修」判定
app.get('/api/rooms/availability', async(req, res) => {
    const { checkIn, checkOut } = req.query;
    try {
        const roomsSnapshot = await db.collection('rooms').get();
        const ordersSnapshot = await db.collection('orders').get();
        const rooms = [];

        roomsSnapshot.forEach(doc => {
            const roomData = { id: doc.id, ...doc.data() };
            const currentStatus = roomData.status || 'available';

            let isUnderMaintenance = false;

            // 關鍵邏輯：檢查使用者選的日期是否與維修日期重疊
            if (currentStatus === 'maintenance') {
                if (roomData.maintenanceStart && roomData.maintenanceEnd) {
                    // 只要「預訂結束日期 > 維修開始」且「預訂開始日期 < 維修結束」，就代表衝突
                    if (checkIn < roomData.maintenanceEnd && checkOut > roomData.maintenanceStart) {
                        isUnderMaintenance = true;
                    }
                } else {
                    // 如果沒有設日期但狀態是維修中，則視為永久維修
                    isUnderMaintenance = true;
                }
            }

            if (isUnderMaintenance) {
                roomData.isFull = true;
                roomData.statusText = "維修中";
                roomData.remaining = 0;
                roomData.status = 'maintenance';
            } else {
                // 計算已被預訂的數量
                let bookedCount = 0;
                ordersSnapshot.forEach(orderDoc => {
                    const order = orderDoc.data();
                    if (order.roomId === doc.id && checkIn < order.checkOut && checkOut > order.checkIn) {
                        bookedCount++;
                    }
                });
                const maxQty = roomData.quantity || 1;
                roomData.remaining = maxQty - bookedCount;
                roomData.isFull = bookedCount >= maxQty;
                roomData.status = 'available';
            }

            rooms.push(roomData);
        });

        res.json(rooms);
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false });
    }
});

// [線上訂房] - 加上維修日期檢測 (防止有人跳過前端直接打 API)
app.post('/api/booking', async(req, res) => {
    const { roomId, checkIn, checkOut } = req.body;
    try {
        const roomDoc = await db.collection('rooms').doc(roomId).get();
        const roomData = roomDoc.data();

        if (!roomDoc.exists) {
            return res.status(404).json({ success: false, message: '找不到該房型' });
        }

        // 再次檢查維修衝突
        if (roomData.status === 'maintenance') {
            const mStart = roomData.maintenanceStart;
            const mEnd = roomData.maintenanceEnd;
            if (!mStart || (checkIn < mEnd && checkOut > mStart)) {
                return res.status(400).json({ success: false, message: '該房型於此時段維修中，請選擇其他日期。' });
            }
        }

        const maxQty = roomData.quantity || 1;
        const ordersSnapshot = await db.collection('orders').where('roomId', '==', roomId).get();
        let bookedCount = 0;

        ordersSnapshot.forEach(doc => {
            const order = doc.data();
            if (checkIn < order.checkOut && checkOut > order.checkIn) bookedCount++;
        });

        if (bookedCount >= maxQty) {
            return res.status(400).json({ success: false, message: '很抱歉，該時段已訂滿。' });
        }

        await db.collection('orders').add({
            ...req.body,
            status: 'confirmed',
            createdAt: new Date().toISOString()
        });

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false });
    }
});

// [管理員取得房型]
app.get('/api/admin/rooms', async(req, res) => {
    const snapshot = await db.collection('rooms').get();
    const rooms = [];
    snapshot.forEach(doc => rooms.push({ id: doc.id, ...doc.data() }));
    res.json(rooms);
});

// [新增/修改房型] - 支援日期區間
app.post('/api/admin/rooms', async(req, res) => {
    const {
        id,
        name,
        price,
        quantity,
        description,
        imageUrl,
        status,
        maintenanceStart,
        maintenanceEnd
    } = req.body;

    const roomInfo = {
        name,
        price: parseInt(price),
        quantity: parseInt(quantity),
        description,
        imageUrl,
        status: status || 'available',
        maintenanceStart: maintenanceStart || null,
        maintenanceEnd: maintenanceEnd || null
    };

    try {
        if (id) {
            await db.collection('rooms').doc(id).update(roomInfo);
        } else {
            await db.collection('rooms').add(roomInfo);
        }
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false });
    }
});

// --- 其他 API (查詢、刪除) ---

app.get('/api/orders/:phone', async(req, res) => {
    const snapshot = await db.collection('orders').where('phone', '==', req.params.phone).get();
    const orders = [];
    snapshot.forEach(doc => {
        orders.push({ id: doc.id, ...doc.data() });
    });
    res.json(orders);
});

app.get('/api/admin/orders', async(req, res) => {
    const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').get();
    const orders = [];
    snapshot.forEach(doc => {
        orders.push({ id: doc.id, ...doc.data() });
    });
    res.json(orders);
});

app.post('/api/orders/cancel/:id', async(req, res) => {
    await db.collection('orders').doc(req.params.id).delete();
    res.json({ success: true });
});

app.delete('/api/admin/rooms/:id', async(req, res) => {
    await db.collection('rooms').doc(req.params.id).delete();
    res.json({ success: true });
});

const PORT = 3000;
app.listen(PORT, () => console.log(`✅ Server is running on http://localhost:${PORT}`));