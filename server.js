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
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/attendance';

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
})
.then(() => {
  console.log('MongoDB Connected Successfully!');
})
.catch(err => console.error('MongoDB Connection Error:', err));

// SCHEMAS

// 1. User Schema (Self-Registration Enabled)
const UserSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, enum: ['TEACHER', 'HOD'], default: 'TEACHER' },
  branch: { type: String, required: true },
  subjects: [String]
});

// 2. Active Session Schema (Strict 20m & 10m TTL)
const SessionSchema = new mongoose.Schema({
  branch: String,
  subject: String,
  teacherId: String,
  passcode: String,
  teacherLat: Number,
  teacherLng: Number,
  radius: { type: Number, default: 20 },
  createdAt: { type: Date, default: Date.now, expires: 600 }
});

// 3. Attendance Record Schema
const AttendanceSchema = new mongoose.Schema({
  studentId: { type: String, required: true },
  branch: { type: String, required: true },
  subject: { type: String, required: true },
  teacherId: { type: String },
  dateStr: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  mode: { type: String, default: 'Online (GPS)' },
  deviceId: { type: String }
});

const User = mongoose.model('User', UserSchema);
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

function getTodayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ================= API ROUTES ================= //

// 1. TEACHER SIGNUP / REGISTER API
app.post('/api/auth/register', async (req, res) => {
  try {
    const { userId, password, name, branch, subjects } = req.body;
    if (!userId || !password || !name || !branch) {
      return res.status(400).json({ success: false, message: 'All fields are required!' });
    }

    const existing = await User.findOne({ userId: userId.trim() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'UserId already exists! Choose another.' });
    }

    const subjectList = subjects ? subjects.split(',').map(s => s.trim()).filter(s => s) : [];

    const newUser = new User({
      userId: userId.trim(),
      password: password.trim(),
      name: name.trim(),
      role: 'TEACHER',
      branch: branch.trim(),
      subjects: subjectList
    });
    await newUser.save();

    res.json({ success: true, message: 'Registration Successful! You can now login.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. LOGIN API
app.post('/api/auth/login', async (req, res) => {
  try {
    const { userId, password } = req.body;
    if (!userId || !password) {
      return res.status(400).json({ success: false, message: 'UserId and Password required!' });
    }

    const user = await User.findOne({ userId: userId.trim() });
    if (!user || user.password !== password.trim()) {
      return res.status(401).json({ success: false, message: 'Invalid Credentials!' });
    }

    res.json({
      success: true,
      message: 'Login Successful!',
      user: {
        userId: user.userId,
        name: user.name,
        role: user.role,
        branch: user.branch,
        subjects: user.subjects
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. START SESSION
app.post('/api/session/start', async (req, res) => {
  try {
    const { branch, subject, passcode, teacherLat, teacherLng, teacherId } = req.body;
    if (!branch || !subject || !passcode) {
      return res.status(400).json({ success: false, message: 'Branch, Subject & Passcode required!' });
    }

    await Session.deleteMany({ branch, subject: new RegExp(`^${subject.trim()}$`, 'i') });

    const session = new Session({
      branch,
      subject: subject.trim(),
      teacherId,
      passcode: passcode.trim(),
      teacherLat,
      teacherLng,
      radius: 20
    });
    await session.save();

    res.json({ success: true, message: `Session started for ${branch} - ${subject} (10 Mins Expiry, 20m Range)!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. STUDENT MARK ATTENDANCE
app.post('/api/attendance/mark', async (req, res) => {
  try {
    const { branch, subject, studentId, enteredCode, userLat, userLng, deviceId } = req.body;

    if (!studentId || !enteredCode) {
      return res.status(400).json({ success: false, message: 'Roll Number and Passcode are required!' });
    }

    const activeSession = await Session.findOne({
      branch: branch,
      subject: new RegExp(`^${subject.trim()}$`, 'i'),
      passcode: enteredCode.trim()
    });

    if (!activeSession) {
      return res.status(400).json({ success: false, message: 'Invalid Passcode or Session Expired (10 mins over)!' });
    }

    // Geofence
    const distance = getDistanceInMeters(activeSession.teacherLat, activeSession.teacherLng, userLat, userLng);
    if (distance > activeSession.radius) {
      return res.status(400).json({ success: false, message: `Out of Class Range! You are ${Math.round(distance)}m away (Max allowed: 20m)` });
    }

    const todayStr = getTodayDateString();
    const formattedStudentId = studentId.trim().toUpperCase();

    // Prevent Duplicates
    const existingStudent = await Attendance.findOne({
      studentId: formattedStudentId,
      branch: branch,
      subject: new RegExp(`^${subject.trim()}$`, 'i'),
      dateStr: todayStr
    });

    if (existingStudent) {
      return res.status(400).json({ success: false, message: 'Attendance already marked for this Roll Number today!' });
    }

    // Proxy Lock
    if (deviceId && deviceId.trim() !== '') {
      const existingDevice = await Attendance.findOne({
        deviceId: deviceId.trim(),
        branch: branch,
        subject: new RegExp(`^${subject.trim()}$`, 'i'),
        dateStr: todayStr
      });

      if (existingDevice) {
        return res.status(400).json({ success: false, message: 'Proxy Detected! This device has already marked attendance today.' });
      }
    }

    const newRecord = new Attendance({
      studentId: formattedStudentId,
      branch: branch,
      subject: activeSession.subject,
      teacherId: activeSession.teacherId,
      dateStr: todayStr,
      mode: 'Online (GPS)',
      deviceId: deviceId ? deviceId.trim() : 'Unknown'
    });
    await newRecord.save();

    res.json({ success: true, message: 'Attendance Marked Successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. MANUAL OVERRIDE
app.post('/api/attendance/manual', async (req, res) => {
  try {
    const { branch, subject, studentId, teacherId, dateStr } = req.body;
    if (!branch || !subject || !studentId) {
      return res.status(400).json({ success: false, message: 'Branch, Subject & Roll Number required!' });
    }

    const targetDate = dateStr || getTodayDateString();
    const formattedStudentId = studentId.trim().toUpperCase();

    const existing = await Attendance.findOne({
      studentId: formattedStudentId,
      branch: branch,
      subject: new RegExp(`^${subject.trim()}$`, 'i'),
      dateStr: targetDate
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'Student already marked Present for this date!' });
    }

    const newRecord = new Attendance({
      studentId: formattedStudentId,
      branch: branch,
      subject: subject.trim(),
      teacherId,
      dateStr: targetDate,
      mode: 'Manual (Teacher)',
      deviceId: 'Teacher_Override'
    });
    await newRecord.save();

    res.json({ success: true, message: `Student ${formattedStudentId} marked Present manually!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 6. FETCH RECORDS (Strict Privacy for Teachers)
app.get('/api/attendance/query', async (req, res) => {
  try {
    const { branch, subject, teacherId, role, dateStr } = req.query;
    let query = {};

    if (role === 'TEACHER') {
      if (teacherId) query.teacherId = teacherId;
    } else if (role === 'HOD') {
      if (branch && branch !== 'ALL') query.branch = branch;
    }

    if (subject && subject.trim() !== '') {
      query.subject = new RegExp(`^${subject.trim()}$`, 'i');
    }

    if (dateStr && dateStr.trim() !== '') {
      query.dateStr = dateStr;
    }

    let records = await Attendance.find(query);
    records.sort((a, b) => a.studentId.localeCompare(b.studentId, undefined, { numeric: true, sensitivity: 'base' }));

    res.json({ success: true, records });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 7. DELETE SHEET
app.delete('/api/attendance/delete-sheet', async (req, res) => {
  try {
    const { branch, subject, dateStr, teacherId, role } = req.body;
    let filter = {
      branch: branch,
      subject: new RegExp(`^${subject.trim()}$`, 'i'),
      dateStr: dateStr
    };

    if (role === 'TEACHER' && teacherId) filter.teacherId = teacherId;

    const result = await Attendance.deleteMany(filter);
    res.json({ success: true, message: `Deleted ${result.deletedCount} records for ${subject} on ${dateStr}!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 8. EXPORT CSV
app.get('/api/attendance/export-sheet', async (req, res) => {
  try {
    const { branch, subject, dateStr, teacherId, role } = req.query;
    let query = {};

    if (role === 'TEACHER' && teacherId) query.teacherId = teacherId;
    if (branch && branch !== 'ALL') query.branch = branch;
    if (subject) query.subject = new RegExp(`^${subject.trim()}$`, 'i');
    if (dateStr) query.dateStr = dateStr;

    let records = await Attendance.find(query);
    records.sort((a, b) => a.studentId.localeCompare(b.studentId, undefined, { numeric: true, sensitivity: 'base' }));

    let csv = 'Roll Number,Branch,Subject,Date,Mode,Time\n';
    records.forEach(r => {
      const timeStr = new Date(r.timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
      csv += `"${r.studentId}","${r.branch}","${r.subject}","${r.dateStr}","${r.mode}","${timeStr}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=Attendance_${subject || 'Report'}_${dateStr || 'All'}.csv`);
    res.status(200).send(csv);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ADD NEW SUBJECT TO EXISTING TEACHER
app.post('/api/teacher/add-subject', async (req, res) => {
  try {
    const { userId, newSubject } = req.body;
    if (!userId || !newSubject) {
      return res.status(400).json({ success: false, message: 'Subject name required!' });
    }

    const user = await User.findOne({ userId });
    if (!user) return res.status(404).json({ success: false, message: 'User not found!' });

    const trimmedSubj = newSubject.trim();
    if (!user.subjects.includes(trimmedSubj)) {
      user.subjects.push(trimmedSubj);
      await user.save();
    }

    res.json({ success: true, message: `Subject '${trimmedSubj}' added successfully!`, subjects: user.subjects });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// SEED HOD MASTER ACCOUNT
async function seedMaster() {
  const hod = await User.findOne({ userId: 'hod_cs' });
  if (!hod) {
    await User.create({
      userId: 'hod_cs',
      password: '123',
      name: 'Dr. Sharma (HOD)',
      role: 'HOD',
      branch: 'ALL',
      subjects: []
    });
    console.log('Default HOD Account Created!');
  }
}
seedMaster();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));