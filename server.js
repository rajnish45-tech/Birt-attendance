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

// 2. Active Session Schema (With Lecture Number & 10m TTL)
const SessionSchema = new mongoose.Schema({
  branch: String,
  subject: String,
  teacherId: String,
  passcode: String,
  lectureNo: { type: Number, default: 1 },
  teacherLat: Number,
  teacherLng: Number,
  radius: { type: Number, default: 30 },
  createdAt: { type: Date, default: Date.now, expires: 600 }
});

// 3. Attendance Record Schema with Lecture Support & Device Fingerprint
const AttendanceSchema = new mongoose.Schema({
  studentId: { type: String, required: true },
  branch: { type: String, required: true },
  subject: { type: String, required: true },
  teacherId: { type: String },
  dateStr: { type: String, required: true },
  lectureNo: { type: Number, default: 1 },
  timestamp: { type: Date, default: Date.now },
  mode: { type: String, default: 'Online (GPS)' },
  deviceId: { type: String }
});

// 🛑 MASTER FIX: Database Level Unique Index including lectureNo
AttendanceSchema.index({ studentId: 1, branch: 1, subject: 1, dateStr: 1, lectureNo: 1 }, { unique: true });

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

// Helper Function: Normalize Roll Numbers
function normalizeInput(str) {
  return str ? str.trim().replace(/\s+/g, '').toUpperCase() : '';
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

// 3. START SESSION (Supports Multiple Lectures per Day)
app.post('/api/session/start', async (req, res) => {
  try {
    const { branch, subject, passcode, teacherLat, teacherLng, teacherId, lectureNo } = req.body;
    if (!branch || !subject || !passcode) {
      return res.status(400).json({ success: false, message: 'Branch, Subject & Passcode required!' });
    }

    const selectedLec = lectureNo ? parseInt(lectureNo) : 1;

    // Remove existing session for same branch, subject & lectureNo
    await Session.deleteMany({
      branch,
      subject: new RegExp(`^${subject.trim()}$`, 'i'),
      lectureNo: selectedLec
    });

    const session = new Session({
      branch,
      subject: subject.trim(),
      teacherId,
      passcode: passcode.trim(),
      lectureNo: selectedLec,
      teacherLat,
      teacherLng,
      radius: 30
    });
    await session.save();

    res.json({
      success: true,
      message: `Session started for ${branch} - ${subject} [Lecture ${selectedLec}] (10 Mins Expiry, 30m Range)!`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. STUDENT MARK ATTENDANCE (BULLET-PROOF ANTI-PROXY & STRICT 12-DIGIT ROLL VALIDATION)
app.post('/api/attendance/mark', async (req, res) => {
  try {
    const { branch, subject, studentId, enteredCode, userLat, userLng, deviceId } = req.body;

    if (!studentId || !enteredCode) {
      return res.status(400).json({ success: false, message: 'Roll Number and Passcode are required!' });
    }

    const cleanStudentId = normalizeInput(studentId);

    // Strict 12-Digit Roll Length Check
    if (cleanStudentId.length < 12) {
      return res.status(400).json({ success: false, message: 'Invalid Roll Number! Roll Number must be at least 12 characters long.' });
    }

    const cleanSubject = subject ? subject.trim() : '';

    const activeSession = await Session.findOne({
      branch: branch,
      subject: new RegExp(`^${cleanSubject}$`, 'i'),
      passcode: enteredCode.trim()
    });

    if (!activeSession) {
      return res.status(400).json({ success: false, message: 'Invalid Passcode or Session Expired (10 mins over)!' });
    }

    // Geofence Range Check
    if (userLat === undefined || userLng === undefined || userLat === null || userLng === null) {
      return res.status(400).json({ success: false, message: 'GPS Location required! Please enable location.' });
    }

    const distance = getDistanceInMeters(activeSession.teacherLat, activeSession.teacherLng, userLat, userLng);
    if (distance > activeSession.radius) {
      return res.status(400).json({ success: false, message: `Out of Class Range! You are ${Math.round(distance)}m away (Max allowed: ${activeSession.radius}m)` });
    }

    const todayStr = getTodayDateString();
    const currentLecture = activeSession.lectureNo || 1;

    // Check 1: Student already marked for this date + lecture?
    const existingStudent = await Attendance.findOne({
      studentId: cleanStudentId,
      branch: branch,
      subject: new RegExp(`^${cleanSubject}$`, 'i'),
      dateStr: todayStr,
      lectureNo: currentLecture
    });

    if (existingStudent) {
      return res.status(400).json({ success: false, message: `Attendance already marked for Roll No ${cleanStudentId} in Lecture ${currentLecture} today!` });
    }

    // Check 2: Proxy Lock (Device Fingerprint)
    if (deviceId && deviceId.trim() !== '') {
      const existingDevice = await Attendance.findOne({
        deviceId: deviceId.trim(),
        branch: branch,
        subject: new RegExp(`^${cleanSubject}$`, 'i'),
        dateStr: todayStr,
        lectureNo: currentLecture
      });

      if (existingDevice) {
        return res.status(400).json({ success: false, message: `Proxy Blocked! This device has already marked attendance for Lecture ${currentLecture} today.` });
      }
    }

    try {
      const newRecord = new Attendance({
        studentId: cleanStudentId,
        branch: branch,
        subject: activeSession.subject,
        teacherId: activeSession.teacherId,
        dateStr: todayStr,
        lectureNo: currentLecture,
        mode: 'Online (GPS)',
        deviceId: deviceId ? deviceId.trim() : 'Unknown'
      });
      await newRecord.save();
    } catch (dbErr) {
      if (dbErr.code === 11000) {
        return res.status(400).json({ success: false, message: `Attendance already marked for Lecture ${currentLecture} today!` });
      }
      throw dbErr;
    }

    res.json({ success: true, message: `Attendance Marked Successfully for Lecture ${currentLecture}!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. COPY ATTENDANCE API (Copy records from Lecture X to Lecture Y in 1-Click)
app.post('/api/attendance/copy-lecture', async (req, res) => {
  try {
    const { branch, subject, sourceLecture, targetLecture, teacherId, dateStr } = req.body;
    if (!branch || !subject || !sourceLecture || !targetLecture) {
      return res.status(400).json({ success: false, message: 'Branch, Subject, Source & Target Lectures required!' });
    }

    const targetDate = dateStr || getTodayDateString();
    const cleanSubject = subject.trim();
    const srcLec = parseInt(sourceLecture);
    const tgtLec = parseInt(targetLecture);

    if (srcLec === tgtLec) {
      return res.status(400).json({ success: false, message: 'Source and Target lectures cannot be the same!' });
    }

    // Source lecture ke saare records nikalein
    const sourceRecords = await Attendance.find({
      branch: branch,
      subject: new RegExp(`^${cleanSubject}$`, 'i'),
      dateStr: targetDate,
      lectureNo: srcLec
    });

    if (sourceRecords.length === 0) {
      return res.status(400).json({ success: false, message: `No attendance records found in Lecture ${srcLec} to copy!` });
    }

    let copiedCount = 0;
    for (let record of sourceRecords) {
      const exists = await Attendance.findOne({
        studentId: record.studentId,
        branch: branch,
        subject: new RegExp(`^${cleanSubject}$`, 'i'),
        dateStr: targetDate,
        lectureNo: tgtLec
      });

      if (!exists) {
        const newRecord = new Attendance({
          studentId: record.studentId,
          branch: branch,
          subject: record.subject,
          teacherId: teacherId || record.teacherId,
          dateStr: targetDate,
          lectureNo: tgtLec,
          mode: `Copied from Lec ${srcLec}`,
          deviceId: 'Teacher_Copied'
        });
        await newRecord.save();
        copiedCount++;
      }
    }

    res.json({
      success: true,
      message: `Successfully copied ${copiedCount} student attendance records from Lecture ${srcLec} to Lecture ${tgtLec}!`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 6. MANUAL OVERRIDE (Teacher Manual Entry)
app.post('/api/attendance/manual', async (req, res) => {
  try {
    const { branch, subject, studentId, teacherId, dateStr, lectureNo } = req.body;
    if (!branch || !subject || !studentId) {
      return res.status(400).json({ success: false, message: 'Branch, Subject & Roll Number required!' });
    }

    const targetDate = dateStr || getTodayDateString();
    const cleanStudentId = normalizeInput(studentId);

    if (cleanStudentId.length < 12) {
      return res.status(400).json({ success: false, message: 'Invalid Roll Number! Minimum 12 characters required.' });
    }

    const cleanSubject = subject.trim();
    const currentLecture = lectureNo ? parseInt(lectureNo) : 1;

    const existing = await Attendance.findOne({
      studentId: cleanStudentId,
      branch: branch,
      subject: new RegExp(`^${cleanSubject}$`, 'i'),
      dateStr: targetDate,
      lectureNo: currentLecture
    });

    if (existing) {
      return res.status(400).json({ success: false, message: `Student already marked Present for Lecture ${currentLecture} on this date!` });
    }

    try {
      const newRecord = new Attendance({
        studentId: cleanStudentId,
        branch: branch,
        subject: cleanSubject,
        teacherId,
        dateStr: targetDate,
        lectureNo: currentLecture,
        mode: 'Manual (Teacher)',
        deviceId: 'Teacher_Override'
      });
      await newRecord.save();
    } catch (dbErr) {
      if (dbErr.code === 11000) {
        return res.status(400).json({ success: false, message: `Student already marked Present for Lecture ${currentLecture}!` });
      }
      throw dbErr;
    }

    res.json({ success: true, message: `Student ${cleanStudentId} marked Present manually for Lecture ${currentLecture}!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 7. FETCH RECORDS (Filtered by Query)
app.get('/api/attendance/query', async (req, res) => {
  try {
    const { branch, subject, teacherId, role, dateStr, lectureNo } = req.query;
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

    if (lectureNo) {
      query.lectureNo = parseInt(lectureNo);
    }

    let records = await Attendance.find(query);

    const uniqueMap = new Map();
    records.forEach(r => {
      const normRoll = normalizeInput(r.studentId);
      const lec = r.lectureNo || 1;
      const key = `${r.branch}_${r.subject.toLowerCase()}_${r.dateStr}_Lec${lec}_${normRoll}`;
      if (!uniqueMap.has(key)) {
        r.studentId = normRoll;
        uniqueMap.set(key, r);
      }
    });

    let uniqueRecords = Array.from(uniqueMap.values());
    uniqueRecords.sort((a, b) => a.studentId.localeCompare(b.studentId, undefined, { numeric: true, sensitivity: 'base' }));

    res.json({ success: true, records: uniqueRecords });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 8. DELETE SHEET
app.delete('/api/attendance/delete-sheet', async (req, res) => {
  try {
    const { branch, subject, dateStr, teacherId, role, lectureNo } = req.body;
    let filter = {
      branch: branch,
      subject: new RegExp(`^${subject.trim()}$`, 'i'),
      dateStr: dateStr
    };

    if (lectureNo) filter.lectureNo = parseInt(lectureNo);
    if (role === 'TEACHER' && teacherId) filter.teacherId = teacherId;

    const result = await Attendance.deleteMany(filter);
    res.json({ success: true, message: `Deleted ${result.deletedCount} records for ${subject} on ${dateStr}!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 9. EXPORT CSV
app.get('/api/attendance/export-sheet', async (req, res) => {
  try {
    const { branch, subject, dateStr, teacherId, role, lectureNo } = req.query;
    let query = {};

    if (role === 'TEACHER' && teacherId) query.teacherId = teacherId;
    if (branch && branch !== 'ALL') query.branch = branch;
    if (subject) query.subject = new RegExp(`^${subject.trim()}$`, 'i');
    if (dateStr) query.dateStr = dateStr;
    if (lectureNo) query.lectureNo = parseInt(lectureNo);

    let records = await Attendance.find(query);

    const uniqueMap = new Map();
    records.forEach(r => {
      const normRoll = normalizeInput(r.studentId);
      const lec = r.lectureNo || 1;
      const key = `${r.branch}_${r.subject.toLowerCase()}_${r.dateStr}_Lec${lec}_${normRoll}`;
      if (!uniqueMap.has(key)) {
        r.studentId = normRoll;
        uniqueMap.set(key, r);
      }
    });

    let uniqueRecords = Array.from(uniqueMap.values());
    uniqueRecords.sort((a, b) => a.studentId.localeCompare(b.studentId, undefined, { numeric: true, sensitivity: 'base' }));

    let csv = 'Roll Number,Branch,Subject,Date,Lecture No,Mode,Time\n';
    uniqueRecords.forEach(r => {
      const timeStr = new Date(r.timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
      csv += `"${r.studentId}","${r.branch}","${r.subject}","${r.dateStr}","Lec ${r.lectureNo || 1}","${r.mode}","${timeStr}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=Attendance_${subject || 'Report'}_${dateStr || 'All'}.csv`);
    res.status(200).send(csv);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 10. STUDENT INDIVIDUAL ERP REPORT API (Accurate Lecture-Wise Held & Present Count)
app.get('/api/attendance/student-report/:studentId', async (req, res) => {
  try {
    const studentId = normalizeInput(req.params.studentId);
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Valid Roll Number required!' });
    }

    if (studentId.length < 12) {
      return res.status(400).json({ success: false, message: 'Invalid Roll Number! Minimum 12 characters required.' });
    }

    const studentRecords = await Attendance.find({ studentId: studentId });

    if (studentRecords.length === 0) {
      return res.json({
        success: true,
        studentId: studentId,
        overallPercentage: "0.00",
        grandTotalHeld: 0,
        grandTotalPresent: 0,
        grandTotalAbsent: 0,
        subjectWise: {}
      });
    }

    const studentBranch = studentRecords[0].branch;
    const subjectStats = {};
    
    const studentSubjects = [...new Set(studentRecords.map(r => r.subject))];

    for (let sub of studentSubjects) {
      const subRecords = studentRecords.filter(r => r.subject.toLowerCase() === sub.toLowerCase());
      
      const allBranchSubRecords = await Attendance.find({
        branch: studentBranch,
        subject: new RegExp(`^${sub.trim()}$`, 'i')
      });

      const uniqueSessionsSet = new Set();
      allBranchSubRecords.forEach(r => {
        uniqueSessionsSet.add(`${r.dateStr}_Lec${r.lectureNo || 1}`);
      });

      const totalHeld = Math.max(uniqueSessionsSet.size, subRecords.length);
      const presentCount = subRecords.length;
      const absentCount = Math.max(0, totalHeld - presentCount);

      subjectStats[sub] = {
        totalHeld: totalHeld,
        present: presentCount,
        absent: absentCount
      };
    }

    let grandTotalHeld = 0;
    let grandTotalPresent = 0;

    Object.keys(subjectStats).forEach(sub => {
      grandTotalHeld += subjectStats[sub].totalHeld;
      grandTotalPresent += subjectStats[sub].present;
    });

    const grandTotalAbsent = Math.max(0, grandTotalHeld - grandTotalPresent);
    const overallPercentage = grandTotalHeld > 0 
      ? ((grandTotalPresent / grandTotalHeld) * 100).toFixed(2) 
      : "0.00";

    res.json({
      success: true,
      studentId: studentId,
      overallPercentage: overallPercentage,
      grandTotalHeld: grandTotalHeld,
      grandTotalPresent: grandTotalPresent,
      grandTotalAbsent: grandTotalAbsent,
      subjectWise: subjectStats
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});