document.getElementById('clearDataBtn').addEventListener('click', async () => {
  if (confirm("Kya aap sure hain ki aap current session ka attendance data delete karna chahte hain?")) {
    const res = await fetch('/api/attendance/clear-all', { method: 'DELETE' });
    const data = await res.json();
    alert(data.message);
    location.reload(); // Refresh table
  }
});