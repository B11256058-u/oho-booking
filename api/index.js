const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

// 請確保此路徑正確，並放入你的 Firebase 私鑰檔案
const serviceAccount = require("../serviceAccountKey.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

app.use(cors());
app.use(express.json());

// ==========================================
// [1. 管理員驗證]
// ==========================================
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    // 這裡可以根據需求改為讀取 DB 或環境變數
    if (username === 'admin' && password === '1234') {
        res.json({ success: true, token: 'hoho-admin-secure-token' });
    } else {
        res.status(401).json({ success: false, message: '帳號或密碼錯誤' });
    }
});

// ==========================================
// [2. Dashboard 統計資料] - 供管理後台圖表使用
// ==========================================
app.get('/api/admin/dashboard', async(req, res) => {
    try {
        const ordersSnapshot = await db.collection('orders').get();

        const monthlyOrders = {};
        const monthlyRevenue = {};

        ordersSnapshot.forEach(doc => {
            const order = doc.data();

            // 必須有建立日期才能統計
            if (!order.createdAt) return;

            const date = new Date(order.createdAt);
            if (isNaN(date.getTime())) return;

            const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

            // 累加訂單數
            monthlyOrders[monthKey] = (monthlyOrders[monthKey] || 0) + 1;
            // 累加營收 (確保 totalPrice 為數字)
            monthlyRevenue[monthKey] = (monthlyRevenue[monthKey] || 0) + (parseInt(order.totalPrice) || 0);
        });

        // 取得所有月份標籤並排序
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

// ==========================================
// [3. 房型可用性檢查] - 支援「日期區間維修」判定
// ==========================================
app.get('/api/rooms/availability', async(req, res) => {
    const { checkIn, checkOut } = req.query;
    if (!checkIn || !checkOut) {
        return res.status(400).json({ success: false, message: '請提供入住與退房日期' });
    }

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
                    // 判斷該房型在該時段是否已有重疊的訂單
                    if (order.roomId === doc.id && checkIn < order.checkOut && checkOut > order.inDate) {
                        bookedCount++;
                    }
                });
                const maxQty = parseInt(roomData.quantity) || 1;
                roomData.remaining = Math.max(0, maxQty - bookedCount);
                roomData.isFull = bookedCount >= maxQty;
                roomData.status = 'available';
            }

            rooms.push(roomData);
        });

        res.json(rooms);
    } catch (error) {
        console.error('Availability check error:', error);
        res.status(500).json({ success: false });
    }
});

// ==========================================
// [4. 線上訂房] - 加上維修日期檢測
// ==========================================
app.post('/api/booking', async(req, res) => {
    const { roomId, checkIn, checkOut, customerName, phone, totalPrice } = req.body;
    try {
        const roomDoc = await db.collection('rooms').doc(roomId).get();
        if (!roomDoc.exists) {
            return res.status(404).json({ success: false, message: '找不到該房型' });
        }

        const roomData = roomDoc.data();

        // 再次檢查維修衝突 (防止繞過前端)
        if (roomData.status === 'maintenance') {
            const mStart = roomData.maintenanceStart;
            const mEnd = roomData.maintenanceEnd;
            if (!mStart || (checkIn < mEnd && checkOut > mStart)) {
                return res.status(400).json({ success: false, message: '該房型於此時段維修中，請選擇其他日期。' });
            }
        }

        // 檢查剩餘數量
        const maxQty = parseInt(roomData.quantity) || 1;
        const ordersSnapshot = await db.collection('orders').where('roomId', '==', roomId).get();
        let bookedCount = 0;

        ordersSnapshot.forEach(doc => {
            const order = doc.data();
            if (checkIn < order.checkOut && checkOut > order.checkIn) {
                bookedCount++;
            }
        });

        if (bookedCount >= maxQty) {
            return res.status(400).json({ success: false, message: '很抱歉，該時段已訂滿。' });
        }

        // 寫入訂單
        await db.collection('orders').add({
            roomId,
            roomName: roomData.name,
            checkIn,
            checkOut,
            customerName,
            phone,
            totalPrice,
            status: 'confirmed',
            createdAt: new Date().toISOString()
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Booking error:', error);
        res.status(500).json({ success: false });
    }
});

// ==========================================
// [5. 管理員：房型 CRUD]
// ==========================================

// 取得所有房型
app.get('/api/admin/rooms', async(req, res) => {
    try {
        const snapshot = await db.collection('rooms').get();
        const rooms = [];
        snapshot.forEach(doc => rooms.push({ id: doc.id, ...doc.data() }));
        res.json(rooms);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// 新增或更新房型
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
        maintenanceEnd: maintenanceEnd || null,
        updatedAt: new Date().toISOString()
    };

    try {
        if (id) {
            // 更新
            await db.collection('rooms').doc(id).update(roomInfo);
        } else {
            // 新增
            await db.collection('rooms').add(roomInfo);
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Save room error:', error);
        res.status(500).json({ success: false });
    }
});

// 刪除房型
app.delete('/api/admin/rooms/:id', async(req, res) => {
    try {
        await db.collection('rooms').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// ==========================================
// [6. 管理員/使用者：訂單查詢與刪除]
// ==========================================

// 使用者根據手機查詢訂單
app.get('/api/orders/:phone', async(req, res) => {
    try {
        const snapshot = await db.collection('orders').where('phone', '==', req.params.phone).get();
        const orders = [];
        snapshot.forEach(doc => {
            orders.push({ id: doc.id, ...doc.data() });
        });
        res.json(orders);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// 管理員取得所有訂單 (依建立時間排序)
app.get('/api/admin/orders', async(req, res) => {
    try {
        const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').get();
        const orders = [];
        snapshot.forEach(doc => {
            orders.push({ id: doc.id, ...doc.data() });
        });
        res.json(orders);
    } catch (error) {
        console.error('Fetch orders error:', error);
        res.status(500).send(error.message);
    }
});

// 刪除/取消訂單
app.post('/api/orders/cancel/:id', async(req, res) => {
    try {
        await db.collection('orders').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// ==========================================
// 啟動伺服器
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ HOHO Hotel Server is running on http://localhost:${PORT}`);
});