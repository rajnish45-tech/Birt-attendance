document.getElementById('clearDataBtn').addEventListener('click', async () => {
  if (confirm("Kya aap sure hain ki aap current session ka attendance data delete karna chahte hain?")) {
    const res = await fetch('/api/attendance/clear-all', { method: 'DELETE' });
    const data = await res.json();
    alert(data.message);
    location.reload(); // Refresh table
  }
});

// Function to clear all attendance data
async function clearData() {
  if (confirm("Kya aap sure hain ki aap current session ka attendance data delete karna chahte hain?")) {
    try {
      const res = await fetch('/api/attendance/clear-all', { method: 'DELETE' });
      const data = await res.json();
      alert(data.message);
      location.reload(); // Table refresh karega
    } catch (err) {
      alert("Error: " + err.message);
    }
  }
}

// 🔄 Student Roll Number Lock & Reset Functions (Added securely without changing existing code)
function lockRollInput() {
  const rollInput = document.getElementById('studentId');
  if (rollInput) {
    rollInput.readOnly = true;
    const resetContainer = document.getElementById('resetContainer');
    if (resetContainer) resetContainer.style.display = 'block';
  }
}

function resetStudentRoll() {
  const rollInput = document.getElementById('studentId');
  if (rollInput) {
    rollInput.readOnly = false;
    rollInput.value = '';
    const resetContainer = document.getElementById('resetContainer');
    if (resetContainer) resetContainer.style.display = 'none';
    localStorage.removeItem('lockedStudentId');
  }
}