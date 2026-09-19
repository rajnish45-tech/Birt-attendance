const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  rollNumber: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  deviceId: { type: String, default: null }
});

module.exports = mongoose.model('User', userSchema);