const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const Attendance = require('./models/Attendance');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://rajnishkrprajapati9523_db_user:diHW4JxVr848N0gS@cluster0.hzu2hrc.mongodb.net/birt_attendance?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB Connected!'))
  .catch(err => console.error('Database Error:', err));

global.currentSession = {
  active: false,
  classLat: null,
  classLng: null,
  maxDistanceMeters: 25
};

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// 1. Teacher Start Session
app.post('/api/session/start', (req, res) => {
  const { lat, lng } = req.body;
  
  global.currentSession = {
    active: true,
    classLat: lat,
    classLng: lng,
    maxDistanceMeters: 25
  };

  return res.json({ success: true, message: 'Classroom Location Set! Attendance window open.' });
});

// 2. Student Attendance Mark Route
app.post('/api/attendance/mark', async (req, res) => {
  const { studentId, userLat, userLng } = req.body;
  const now = new Date();
  const currentHour = now.getHours();

  if (!global.currentSession.active) {
    return res.status(400).json({ success: false, message: 'Teacher ne abhi attendance start nahi ki hai!' });
  }

  // Auto Determine Slot (Subah vs Dopahar)
  let sessionType = '';
  if (currentHour >= 6 && currentHour < 12) {
    sessionType = 'Morning';
  } else if (currentHour >= 12 && currentHour < 18) {
    sessionType = 'Afternoon';
  } else {
    return res.status(400).json({ success: false, message: 'Attendance timing sirf Subah ya Dopahar ke slots me allowed hai!' });
  }

  // Location Verification
  const distance = calculateDistance(
    global.currentSession.classLat,
    global.currentSession.classLng,
    userLat,
    userLng
  );

  if (distance > global.currentSession.maxDistanceMeters) {
    return res.status(403).json({ 
      success: false, 
      message: `Classroom ke bahar hain! Distance: ${Math.round(distance)} meters.` 
    });
  }

  const todayDate = now.toISOString().split('T')[0]; // YYYY-MM-DD

  try {
    // Save Record for Semester 5
    const newRecord = new Attendance({
      studentId,
      semester: 'Semester 5',
      sessionType,
      date: todayDate,
      latitude: userLat,
      longitude: userLng
    });

    await newRecord.save();

    return res.json({
      success: true,
      message: `Semester 5 (${sessionType} Session) Attendance Successfully Marked!`,
      studentId,
      sessionType
    });
  } catch (err) {
    if (err.code === 11000) { // Duplicate Entry Error Code
      return res.status(400).json({ 
        success: false, 
        message: `Aapne ${sessionType} session ki attendance pehle hi laga li hai!` 
      });
    }
    return res.status(500).json({ success: false, message: 'Database Save Error!' });
  }
});

// 3. Fetch Live List
app.get('/api/attendance/list', async (req, res) => {
  try {
    const records = await Attendance.find().sort({ timestamp: -1 });
    res.json(records);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching records' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Mobile Access URL: http://YOUR_PC_IP:${PORT}`);
});