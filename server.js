const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/attendance', {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB Connection Error:', err));

// Schemas
const SessionSchema = new mongoose.Schema({
  branch: String,
  subject: String,
  passcode: String,
  teacherLat: Number,
  teacherLng: Number,
  radius: { type: Number, default: 100 }, // Radius in meters
  createdAt: { type: Date, default: Date.now, expires: 3600 } // Auto expire after 1 hr
});

const AttendanceSchema = new mongoose.Schema({
  studentId: String,
  branch: String,
  subject: String,
  timestamp: { type: Date, default: Date.now },
  mode: { type: String, default: 'Online (GPS)' }, // 'Online (GPS)' or 'Manual (Teacher)'
  deviceId: String
});

// Index to prevent duplicate attendance for same student, subject, branch on same day
AttendanceSchema.index({ studentId: 1, branch: 1, subject: 1, dateString: 1 });

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
    const { branch, subject, passcode, teacherLat, teacherLng, radius } = req.body;
    await Session.deleteMany({ branch, subject }); // Clear previous active sessions for same subject

    const session = new Session({
      branch,
      subject,
      passcode,
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
    const { branch, subject, studentId, enteredCode, userLat, userLng, deviceId } = req.body;

    const activeSession = await Session.findOne({ branch, subject, passcode: enteredCode });
    if (!activeSession) {
      return res.status(400).json({ success: false, message: 'Invalid Passcode or Session Expired!' });
    }

    // Check GPS Distance
    const distance = getDistanceInMeters(activeSession.teacherLat, activeSession.teacherLng, userLat, userLng);
    if (distance > activeSession.radius) {
      return res.status(400).json({ success: false, message: `Out of Class Range! (${Math.round(distance)}m away)` });
    }

    // Check Today's Duplicate
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const existing = await Attendance.findOne({
      studentId: studentId.trim().toUpperCase(),
      branch,
      subject,
      timestamp: { $gte: startOfDay }
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'Attendance already marked for today!' });
    }

    // Save Attendance
    const newRecord = new Attendance({
      studentId: studentId.trim().toUpperCase(),
      branch,
      subject,
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
    const { branch, subject, studentId } = req.body;
    if (!branch || !subject || !studentId) {
      return res.status(400).json({ success: false, message: 'All fields are required!' });
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const existing = await Attendance.findOne({
      studentId: studentId.trim().toUpperCase(),
      branch,
      subject,
      timestamp: { $gte: startOfDay }
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'Student is already marked Present!' });
    }

    const newRecord = new Attendance({
      studentId: studentId.trim().toUpperCase(),
      branch,
      subject,
      mode: 'Manual (Teacher)'
    });
    await newRecord.save();

    res.json({ success: true, message: `Student ${studentId.toUpperCase()} marked Present manually!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Get Attendance Records with Sorting (Ascending Roll No.)
app.get('/api/attendance/all', async (req, res) => {
  try {
    const { branch, subject } = req.query;
    let query = {};
    if (branch && branch !== 'ALL') query.branch = branch;
    if (subject && subject !== 'ALL') query.subject = new RegExp(`^${subject}$`, 'i');

    // Sorted Ascending by Student Roll Number
    const records = await Attendance.find(query).sort({ studentId: 1 });
    res.json({ success: true, records });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. Export CSV/Excel
app.get('/api/attendance/export', async (req, res) => {
  try {
    const { branch, subject } = req.query;
    let query = {};
    if (branch && branch !== 'ALL') query.branch = branch;
    if (subject && subject !== 'ALL') query.subject = new RegExp(`^${subject}$`, 'i');

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