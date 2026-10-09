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
  Attendance.collection.dropIndexes()
    .then(() => console.log('Old indexes cleared successfully.'))
    .catch(err => console.log('Index clear note:', err.message));
})
.catch(err => console.error('MongoDB Connection Error:', err));

// SCHEMAS

// 1. User Schema (Teachers & HOD)
const UserSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, enum: ['TEACHER', 'HOD'], default: 'TEACHER' },
  branch: { type: String, required: true },
  subjects: [String] // Array of subjects assigned to teacher
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
  createdAt: { type: Date, default: Date.now, expires: 600 } // Auto-expire after 10 mins
});

// 3. Attendance Record Schema
const AttendanceSchema = new mongoose.Schema({
  studentId: { type: String, required: true },
  branch: { type: String, required: true },
  subject: { type: String, required: true },
  teacherId: { type: String },
  dateStr: { type: String, required: true }, // Format: YYYY-MM-DD
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

// Get Today's Date String (YYYY-MM-DD)
function getTodayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ================= API ROUTES ================= //

// 1. LOGIN API (Teachers & HOD)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { userId, password } = req.body;
    if (!userId || !password) {
      return res.status(400).json({ success: false, message: 'UserId and Password are required!' });
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

// 2. TEACHER STARTS LIVE SESSION
app.post('/api/session/start', async (req, res) => {
  try {
    const { branch, subject, passcode, teacherLat, teacherLng, teacherId } = req.body;
    if (!branch || !subject || !passcode) {
      return res.status(400).json({ success: false, message: 'Branch, Subject, and Passcode are required!' });
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

    res.json({ success: true, message: `Session started for ${subject} (10 Min Expiry, 20m Range)!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. STUDENT MARKS ATTENDANCE
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
      return res.status(400).json({ success: false, message: 'Invalid Passcode or Session Expired (10 mins limit over)!' });
    }

    // Geofencing Check (20m Range)
    const distance = getDistanceInMeters(activeSession.teacherLat, activeSession.teacherLng, userLat, userLng);
    if (distance > activeSession.radius) {
      return res.status(400).json({ success: false, message: `Out of Class Range! You are ${Math.round(distance)}m away (Max allowed: 20m)` });
    }

    const todayStr = getTodayDateString();
    const formattedStudentId = studentId.trim().toUpperCase();

    // Prevent Duplicate Roll Number for Today
    const existingStudent = await Attendance.findOne({
      studentId: formattedStudentId,
      branch: branch,
      subject: new RegExp(`^${subject.trim()}$`, 'i'),
      dateStr: todayStr
    });

    if (existingStudent) {
      return res.status(400).json({ success: false, message: 'Attendance already marked for this Roll Number today!' });
    }

    // Prevent Proxy (Device Locking)
    if (deviceId && deviceId.trim() !== '') {
      const existingDevice = await Attendance.findOne({
        deviceId: deviceId.trim(),
        branch: branch,
        subject: new RegExp(`^${subject.trim()}$`, 'i'),
        dateStr: todayStr
      });

      if (existingDevice) {
        return res.status(400).json({
          success: false,
          message: 'Proxy Detected! This mobile phone has already been used to mark attendance today.'
        });
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

// 4. MANUAL OVERRIDE BY TEACHER
app.post('/api/attendance/manual', async (req, res) => {
  try {
    const { branch, subject, studentId, teacherId, dateStr } = req.body;
    if (!branch || !subject || !studentId) {
      return res.status(400).json({ success: false, message: 'Branch, Subject and Student ID are required!' });
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
      return res.status(400).json({ success: false, message: 'Student is already marked Present for this date!' });
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

// 5. FETCH ATTENDANCE RECORDS (With Teacher Privacy & Date Filtering)
app.get('/api/attendance/query', async (req, res) => {
  try {
    const { branch, subject, teacherId, role, dateStr } = req.query;
    let query = {};

    if (role === 'TEACHER') {
      if (teacherId) query.teacherId = teacherId;
      if (branch) query.branch = branch;
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

// 6. DELETE SPECIFIC SHEET (By Date & Subject)
app.delete('/api/attendance/delete-sheet', async (req, res) => {
  try {
    const { branch, subject, dateStr, teacherId, role } = req.body;
    if (!branch || !subject || !dateStr) {
      return res.status(400).json({ success: false, message: 'Branch, Subject, and Date are required for deletion!' });
    }

    let filter = {
      branch: branch,
      subject: new RegExp(`^${subject.trim()}$`, 'i'),
      dateStr: dateStr
    };

    if (role === 'TEACHER' && teacherId) {
      filter.teacherId = teacherId;
    }

    const result = await Attendance.deleteMany(filter);
    res.json({ success: true, message: `Deleted ${result.deletedCount} records for ${subject} on ${dateStr}!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 7. EXPORT SPECIFIC DATE/SUBJECT CSV
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

// SEED INITIAL TEACHERS & HOD DEMO ACCOUNTS
async function seedUsers() {
  const count = await User.countDocuments();
  if (count === 0) {
    await User.create([
      { userId: 'hod_cs', password: '123', name: 'Dr. Sharma (HOD)', role: 'HOD', branch: 'Computer Science', subjects: [] },
      { userId: 'teacher_java', password: '123', name: 'Prof. Verma', role: 'TEACHER', branch: 'Computer Science', subjects: ['Java', 'DBMS'] },
      { userId: 'teacher_os', password: '123', name: 'Prof. Gupta', role: 'TEACHER', branch: 'Computer Science', subjects: ['OS', 'Networking'] }
    ]);
    console.log('Default HOD & Teacher accounts created!');
  }
}
seedUsers();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));