const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  studentId: { type: String, required: true },
  semester: { type: String, default: 'Semester 5' },
  branch: { 
    type: String, 
    required: true,
    enum: ['Computer Science', 'AIML', 'EC', 'EX', 'Mechanical', 'CIVIL']
  },
  subject: { type: String, required: true },
  date: { type: String, required: true },
  deviceId: { type: String, required: true },
  latitude: { type: Number },
  longitude: { type: Number },
  timestamp: { type: Date, default: Date.now }
});

// Unique Check: Student ek subject me ek din me ek hi baar attendance lagaye
attendanceSchema.index({ studentId: 1, branch: 1, subject: 1, date: 1 }, { unique: true });

// Device Lock Check: Ek mobile se ek subject me ek din ek hi attendance lage
attendanceSchema.index({ deviceId: 1, branch: 1, subject: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Attendance', attendanceSchema);