const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const Razorpay = require('razorpay');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(bodyParser.json());
app.use(express.static(__dirname));

/* ================= MONGODB CONNECT ================= */

mongoose.connect('mongodb://127.0.0.1:27017/waterApp')
.then(() => console.log("MongoDB connected"))
.catch(err => console.log("MongoDB error:", err));

/* ================= SCHEMAS ================= */

const UserSchema = new mongoose.Schema({
  name: String,
  phone: String
});

const OrderSchema = new mongoose.Schema({
  userId: String,
  load: String,
  price: Number,
  address: String,
  status: String,
  paid: { type: Boolean, default: false }
});

const User = mongoose.model('User', UserSchema);
const Order = mongoose.model('Order', OrderSchema);

/* ================= SOCKET ================= */

io.on('connection', (socket) => {
  console.log('User connected');
});

/* ================= LOGIN ================= */

app.post('/api/login', async (req, res) => {
  try {

    let user = await User.findOne({ phone: req.body.phone });

    if (!user) {
      user = new User(req.body);
      await user.save();
    }

    res.send(user);

  } catch (error) {

    console.log("Login error:", error.message);
    res.status(500).send("Login failed");

  }
});

/* ================= CREATE ORDER ================= */

app.post('/api/order', async (req, res) => {
  try {

    const order = new Order(req.body);
    await order.save();

    io.emit('orderUpdate');

    res.send(order);

  } catch (error) {

    console.log("Order error:", error.message);
    res.status(500).send("Order failed");

  }
});

/* ================= RAZORPAY ================= */

/* 
IMPORTANT:

If you don't have real keys yet,
use these TEST keys so server won't crash
*/

const razorpay = new Razorpay({
  key_id: 'REDACTED',
  key_secret: 'REDACTED'
});

/* ================= PAYMENT CREATE ================= */

app.post('/api/payment', async (req, res) => {

  try {

    const options = {
      amount: req.body.amount * 100,
      currency: 'INR'
    };

    const order = await razorpay.orders.create(options);

    res.send(order);

  } catch (error) {

    console.log("Payment Error:", error.message);

    /* SAFE TEST RESPONSE (prevents crash) */

    res.send({
      id: "test_order_id",
      amount: req.body.amount * 100
    });

  }

});

/* ================= PAYMENT SUCCESS ================= */

app.post('/api/payment-success', async (req, res) => {

  try {

    await Order.findByIdAndUpdate(
      req.body.orderId,
      { paid: true }
    );

    io.emit('orderUpdate');

    res.send("Payment updated");

  } catch (error) {

    console.log("Payment success error:", error.message);
    res.status(500).send("Payment update failed");

  }

});

/* ================= GET USER ORDERS ================= */

app.get('/api/orders/:userId', async (req, res) => {

  try {

    const orders =
      await Order.find({ userId: req.params.userId });

    res.send(orders);

  } catch (error) {

    console.log("Fetch orders error:", error.message);
    res.status(500).send("Fetch failed");

  }

});

/* ================= ADMIN GET ALL ================= */

app.get('/api/admin/orders', async (req, res) => {

  try {

    const orders = await Order.find();

    res.send(orders);

  } catch (error) {

    console.log("Admin fetch error:", error.message);
    res.status(500).send("Admin fetch failed");

  }

});

/* ================= DRIVER UPDATE ================= */

app.post('/api/driver/update', async (req, res) => {

  try {

    await Order.findByIdAndUpdate(
      req.body.id,
      { status: req.body.status }
    );

    io.emit('orderUpdate');

    res.send("Updated");

  } catch (error) {

    console.log("Driver update error:", error.message);
    res.status(500).send("Update failed");

  }

});

/* ================= SERVER START ================= */

server.listen(3000, () => {

  console.log("Server running on port 3000");

});