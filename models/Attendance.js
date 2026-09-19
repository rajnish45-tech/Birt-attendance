const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  studentId: { type: String, required: true },
  semester: { type: String, default: 'Semester 5' },
  sessionType: { type: String, enum: ['Morning', 'Afternoon'], required: true },
  date: { type: String, required: true }, // Format: YYYY-MM-DD
  timestamp: { type: Date, default: Date.now },
  status: { type: String, default: 'Present' },
  latitude: Number,
  longitude: Number
});

// Ek student ek hi date aur session me dubara attendance na laga sake
attendanceSchema.index({ studentId: 1, date: 1, sessionType: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);