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

// Global Storage for Active Sessions (Key: Branch_Subject)
global.activeSessions = {};

// Distance Calculation Function (Meters)
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

// 1. Teacher Session Start
app.post('/api/session/start', (req, res) => {
  const { branch, subject, teacherCode, lat, lng } = req.body;

  const validBranches = ['Computer Science', 'AIML', 'EC', 'EX', 'Mechanical', 'CIVIL'];

  if (!validBranches.includes(branch)) {
    return res.status(400).json({ success: false, message: 'Invalid Branch selected!' });
  }

  if (!subject || subject.trim() === '') {
    return res.status(400).json({ success: false, message: 'Subject name enter karna zaroori hai!' });
  }

  if (!teacherCode || teacherCode.toString().length !== 4) {
    return res.status(400).json({ success: false, message: '4-digit ka passcode enter karein!' });
  }

  if (!lat || !lng) {
    return res.status(400).json({ success: false, message: 'GPS location capture nahi ho paya!' });
  }

  const sessionKey = `${branch.trim()}_${subject.trim().toLowerCase()}`;

  global.activeSessions[sessionKey] = {
    active: true,
    branch: branch.trim(),
    subject: subject.trim(),
    teacherCode: teacherCode.toString(),
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    maxDistanceMeters: 20,
    startTime: Date.now()
  };

  return res.json({
    success: true,
    message: `Session Started! Branch: ${branch} | Subject: ${subject} | Code: ${teacherCode}`
  });
});

// 2. Student Mark Attendance
app.post('/api/attendance/mark', async (req, res) => {
  const { studentId, branch, subject, enteredCode, userLat, userLng, deviceId } = req.body;
  const now = Date.now();

  if (!branch || !subject) {
    return res.status(400).json({ success: false, message: 'Branch aur Subject dono select karein!' });
  }

  const sessionKey = `${branch.trim()}_${subject.trim().toLowerCase()}`;
  const session = global.activeSessions[sessionKey];

  if (!session || !session.active) {
    return res.status(400).json({ success: false, message: `${branch} (${subject}) ke liye abhi koi active session nahi hai!` });
  }

  if (now - session.startTime > 10 * 60 * 1000) {
    session.active = false;
    return res.status(400).json({ success: false, message: '10 min ka session time samapt ho gaya hai!' });
  }

  if (enteredCode.toString() !== session.teacherCode) {
    return res.status(401).json({ success: false, message: 'Galat 4-digit passcode enter kiya hai!' });
  }

  const distance = calculateDistance(session.lat, session.lng, userLat, userLng);
  if (distance > session.maxDistanceMeters) {
    return res.status(403).json({
      success: false,
      message: `Aap classroom ke bahar hain! Distance: ${Math.round(distance)} meters (Max: 20m).`
    });
  }

  const todayDate = new Date().toISOString().split('T')[0];

  try {
    const newRecord = new Attendance({
      studentId,
      semester: 'Semester 5',
      branch: session.branch,
      subject: session.subject,
      date: todayDate,
      deviceId: deviceId || 'UNKNOWN_DEVICE',
      latitude: userLat,
      longitude: userLng
    });

    await newRecord.save();

    return res.json({
      success: true,
      message: `Attendance Successfully Marked for ${session.subject}!`,
      studentId,
      branch: session.branch,
      subject: session.subject
    });
  } catch (err) {
    if (err.code === 11000) {
      if (err.message.includes('deviceId')) {
        return res.status(400).json({ success: false, message: `Is device se ${session.subject} ki attendance lag chuki hai!` });
      }
      return res.status(400).json({ success: false, message: `Roll Number ${studentId} ki ${session.subject} me attendance lag chuki hai!` });
    }
    return res.status(500).json({ success: false, message: 'Database Error: ' + err.message });
  }
});

// 3. Get All Attendance Records for Teacher & HOD
app.get('/api/attendance/all', async (req, res) => {
  try {
    const records = await Attendance.find().sort({ timestamp: -1 });
    res.json(records);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching records' });
  }
});

// 4. Download Excel/CSV Report for Teacher & HOD
app.get('/api/attendance/export', async (req, res) => {
  try {
    const { branch, subject } = req.query;
    let query = {};

    if (branch) query.branch = branch;
    if (subject) query.subject = subject;

    const records = await Attendance.find(query).sort({ timestamp: -1 });

    let csvData = "Roll Number,Branch,Subject,Date & Time,Device ID\n";

    records.forEach(row => {
      const dateTime = row.timestamp ? new Date(row.timestamp).toLocaleString('en-IN') : row.date;
      csvData += `"${row.studentId}","${row.branch}","${row.subject}","${dateTime}","${row.deviceId}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=Attendance_Report_${branch || 'ALL'}_${Date.now()}.csv`);
    return res.status(200).send(csvData);

  } catch (err) {
    res.status(500).json({ success: false, message: 'Export error: ' + err.message });
  }
});

// 5. Delete Specific Subject Data
app.delete('/api/attendance/delete-subject', async (req, res) => {
  const { branch, subject } = req.body;
  if (!branch || !subject) {
    return res.status(400).json({ success: false, message: 'Branch aur Subject dono enter karein!' });
  }

  try {
    await Attendance.deleteMany({ branch, subject });
    res.json({ success: true, message: `"${branch}" ke "${subject}" ka record delete ho gaya!` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Delete error: ' + err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});