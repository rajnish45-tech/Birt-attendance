const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB Connection with Safe Timeout Options
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/attendance';

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
})
.then(() => console.log('MongoDB Connected Successfully!'))
.catch(err => console.error('MongoDB Connection Error:', err));

// Schemas
const SessionSchema = new mongoose.Schema({
  branch: String,
  subject: String,
  passcode: String,
  teacherLat: Number,
  teacherLng: Number,
  radius: { type: Number, default: 100 },
  createdAt: { type: Date, default: Date.now, expires: 3600 }
});

const AttendanceSchema = new mongoose.Schema({
  studentId: String,
  branch: String,
  subject: String,
  timestamp: { type: Date, default: Date.now },
  mode: { type: String, default: 'Online (GPS)' },
  deviceId: String
});

const Session = mongoose.model('Session', SessionSchema);
const Attendance = mongoose.model('Attendance', AttendanceSchema);

// Distance Helper (Haversine Formula)
function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// 1. Teacher Starts Session
app.post('/api/session/start', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(500).json({ success: false, message: 'Database connecting... please try again in 5 seconds.' });
    }

    const { branch, subject, passcode, teacherLat, teacherLng, radius } = req.body;
    await Session.deleteMany({ branch, subject: new RegExp(`^${subject.trim()}$`, 'i') });

    const session = new Session({
      branch,
      subject: subject.trim(),
      passcode: passcode.trim(),
      teacherLat,
      teacherLng,
      radius: radius || 100
    });
    await session.save();

    res.json({ success: true, message: `Session started for ${branch} - ${subject}!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Student Marks Attendance (GPS)
app.post('/api/attendance/mark', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(500).json({ success: false, message: 'Database connection establishing, please try again.' });
    }

    const { branch, subject, studentId, enteredCode, userLat, userLng, deviceId } = req.body;

    const activeSession = await Session.findOne({ 
      branch: branch, 
      subject: new RegExp(`^${subject.trim()}$`, 'i'), 
      passcode: enteredCode.trim() 
    });

    if (!activeSession) {
      return res.status(400).json({ success: false, message: 'Invalid Passcode or Session Expired!' });
    }

    const distance = getDistanceInMeters(activeSession.teacherLat, activeSession.teacherLng, userLat, userLng);
    if (distance > activeSession.radius) {
      return res.status(400).json({ success: false, message: `Out of Class Range! (${Math.round(distance)}m away)` });
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const existing = await Attendance.findOne({
      studentId: studentId.trim().toUpperCase(),
      branch: branch,
      subject: new RegExp(`^${subject.trim()}$`, 'i'),
      timestamp: { $gte: startOfDay }
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'Attendance already marked for today!' });
    }

    const newRecord = new Attendance({
      studentId: studentId.trim().toUpperCase(),
      branch: branch,
      subject: activeSession.subject,
      mode: 'Online (GPS)',
      deviceId
    });
    await newRecord.save();

    res.json({ success: true, message: 'Attendance Marked Successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Teacher Manual Attendance Override
app.post('/api/attendance/manual', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(500).json({ success: false, message: 'Database connecting, try again.' });
    }

    const { branch, subject, studentId } = req.body;
    if (!branch || !subject || !studentId) {
      return res.status(400).json({ success: false, message: 'All fields are required!' });
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const existing = await Attendance.findOne({
      studentId: studentId.trim().toUpperCase(),
      branch: branch,
      subject: new RegExp(`^${subject.trim()}$`, 'i'),
      timestamp: { $gte: startOfDay }
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'Student is already marked Present!' });
    }

    const newRecord = new Attendance({
      studentId: studentId.trim().toUpperCase(),
      branch: branch,
      subject: subject.trim(),
      mode: 'Manual (Teacher)'
    });
    await newRecord.save();

    res.json({ success: true, message: `Student ${studentId.toUpperCase()} marked Present manually!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Get Attendance Records (Ascending Roll No.)
app.get('/api/attendance/all', async (req, res) => {
  try {
    const { branch, subject } = req.query;
    let query = {};
    if (branch && branch !== 'ALL') query.branch = branch;
    if (subject && subject.trim() !== '') query.subject = new RegExp(`^${subject.trim()}$`, 'i');

    const records = await Attendance.find(query).sort({ studentId: 1 });
    res.json({ success: true, records });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. Delete Attendance Data for Specific Subject/Branch
app.delete('/api/attendance/delete', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(500).json({ success: false, message: 'Database connecting, try again.' });
    }

    const { branch, subject } = req.body;
    if (!branch || !subject) {
      return res.status(400).json({ success: false, message: 'Branch and Subject are required for deletion!' });
    }

    const result = await Attendance.deleteMany({
      branch: branch,
      subject: new RegExp(`^${subject.trim()}$`, 'i')
    });

    res.json({ 
      success: true, 
      message: `${result.deletedCount} attendance records deleted for ${subject} (${branch})!` 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 6. Export CSV/Excel
app.get('/api/attendance/export', async (req, res) => {
  try {
    const { branch, subject } = req.query;
    let query = {};
    if (branch && branch !== 'ALL') query.branch = branch;
    if (subject && subject.trim() !== '') query.subject = new RegExp(`^${subject.trim()}$`, 'i');

    const records = await Attendance.find(query).sort({ studentId: 1 });

    let csv = 'Roll Number,Branch,Subject,Mode,Time\n';
    records.forEach(r => {
      const timeStr = new Date(r.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      csv += `"${r.studentId}","${r.branch}","${r.subject}","${r.mode}","${timeStr}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=Attendance_Report.csv');
    res.status(200).send(csv);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));