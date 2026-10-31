const user = JSON.parse(localStorage.getItem('user'));
  if (!user || user.role !== 'HOD') window.location.href = '/login.html';

  document.getElementById('filterDate').value = new Date().toISOString().split('T')[0];

  function logout() {
    localStorage.removeItem('user');
    window.location.href = '/login.html';
  }

  function switchTab(tabName) {
    document.getElementById('dailyView').style.display = 'none';
    document.getElementById('erpView').style.display = 'none';
    document.getElementById('searchView').style.display = 'none';
    document.getElementById('approvalView').style.display = 'none';

    document.getElementById('tabDailyBtn').classList.remove('active');
    document.getElementById('tabErpBtn').classList.remove('active');
    document.getElementById('tabSearchBtn').classList.remove('active');
    document.getElementById('tabApprovalBtn').classList.remove('active');

    if (tabName === 'daily') {
      document.getElementById('dailyView').style.display = 'block';
      document.getElementById('tabDailyBtn').classList.add('active');
      fetchRecords();
    } else if (tabName === 'erp') {
      document.getElementById('erpView').style.display = 'block';
      document.getElementById('tabErpBtn').classList.add('active');
      fetchConsolidatedERPReport();
    } else if (tabName === 'search') {
      document.getElementById('searchView').style.display = 'block';
      document.getElementById('tabSearchBtn').classList.add('active');
    } else if (tabName === 'approval') {
      document.getElementById('approvalView').style.display = 'block';
      document.getElementById('tabApprovalBtn').classList.add('active');
      loadPendingTeachers();
    }
  }

  // 1. Fetch Daily Attendance Records
  async function fetchRecords() {
    const branch = document.getElementById('filterBranch').value;
    const dateStr = document.getElementById('filterDate').value;

    try {
      const res = await fetch(`/api/attendance/query?role=HOD&branch=${branch}&dateStr=${dateStr}`);
      const data = await res.json();

      document.getElementById('totalCount').innerText = data.records ? data.records.length : 0;

      let html = `<table><thead><tr><th>#</th><th>Roll No</th><th>Branch</th><th>Subject</th><th>Mode</th><th>Time</th></tr></thead><tbody>`;
      if (data.records && data.records.length > 0) {
        data.records.forEach((r, idx) => {
          const time = new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          html += `<tr><td>${idx+1}</td><td><b>${r.studentId}</b></td><td>${r.branch}</td><td>${r.subject}</td><td>${r.mode}</td><td>${time}</td></tr>`;
        });
      } else {
        html += `<tr><td colspan="6" style="text-align:center;">No records found.</td></tr>`;
      }
      html += `</tbody></table>`;
      document.getElementById('hodRecords').innerHTML = html;
    } catch (e) {
      document.getElementById('hodRecords').innerHTML = `<p style="color:red;">Error fetching daily records!</p>`;
    }
  }

  // 2. Fetch Consolidated Batch ERP Attendance Report
  async function fetchConsolidatedERPReport() {
    const branch = document.getElementById('erpFilterBranch').value;
    const erpDiv = document.getElementById('erpReportSection');

    erpDiv.innerHTML = "<p>Loading batch report...</p>";

    try {
      const res = await fetch(`/api/attendance/hod-report?branch=${branch}`);
      const data = await res.json();

      if (!data.success || !data.studentsData) {
        erpDiv.innerHTML = "<p style='color:red;'>Failed to load ERP report.</p>";
        return;
      }

      let html = `<table>
        <thead>
          <tr>
            <th>#</th>
            <th>Roll Number</th>
            <th>Branch</th>
            <th>Total Held</th>
            <th>Present</th>
            <th>Absent</th>
            <th>Overall Percentage</th>
            <th>Status (75% Criteria)</th>
          </tr>
        </thead>
        <tbody>`;

      if (data.studentsData.length > 0) {
        data.studentsData.forEach((st, idx) => {
          const isEligible = parseFloat(st.percentage) >= 75;
          const statusClass = isEligible ? 'badge-success' : 'badge-danger';
          const statusText = isEligible ? 'Eligible (≥75%)' : 'Shortage (<75%)';

          html += `<tr>
            <td>${idx + 1}</td>
            <td><b>${st.studentId}</b></td>
            <td>${st.branch}</td>
            <td>${st.totalHeld}</td>
            <td style="color:#48bb78; font-weight:bold;">${st.present}</td>
            <td style="color:#f56565; font-weight:bold;">${st.absent}</td>
            <td style="font-size:15px;"><b>${st.percentage}%</b></td>
            <td class="${statusClass}">${statusText}</td>
          </tr>`;
        });
      } else {
        html += `<tr><td colspan="8" style="text-align:center;">No student attendance data available.</td></tr>`;
      }

      html += `</tbody></table>`;
      erpDiv.innerHTML = html;
    } catch (e) {
      erpDiv.innerHTML = "<p style='color:red;'>Server connection error!</p>";
    }
  }

  // 3. Search Individual Student Attendance Report By Roll No
  async function searchStudentByHOD() {
    const rollNo = document.getElementById('searchRollNo').value.trim().toUpperCase();
    const resultDiv = document.getElementById('studentSearchResult');

    if (!rollNo) {
      alert("Kripya Roll Number enter karein!");
      return;
    }

    resultDiv.innerHTML = "<p style='color:#63b3ed;'>Searching student records...</p>";

    try {
      const res = await fetch(`/api/attendance/student-report/${rollNo}`);
      const data = await res.json();

      if (!data.success || Object.keys(data.subjectWise).length === 0) {
        resultDiv.innerHTML = `<p style='color:#f56565;'>❌ Roll Number (${rollNo}) ka koi record nahi mila!</p>`;
        return;
      }

      let html = `
        <div style="background: #1a202c; padding: 15px; border-radius: 8px; border: 1px solid #4a5568; margin-top: 15px; text-align: left;">
          <h4 style="color: #48bb78; margin-top:0;">📋 Student Attendance Summary: ${data.studentId}</h4>
          <p style="font-size: 14px; margin-bottom: 15px;">
            <b>Total Held:</b> ${data.grandTotalHeld} | 
            <b>Present:</b> ${data.grandTotalPresent} | 
            <b>Absent:</b> ${data.grandTotalAbsent}<br>
            <span style="font-size: 16px; color: #3182ce;"><b>Overall Attendance: ${data.overallPercentage}%</b></span>
          </p>
          
          <table style="width: 100%; text-align: center;">
            <thead>
              <tr>
                <th style="text-align: left;">Subject</th>
                <th>Total Held</th>
                <th>Present</th>
                <th>Absent</th>
                <th>Percentage (%)</th>
              </tr>
            </thead>
            <tbody>
      `;

      for (let sub in data.subjectWise) {
        let item = data.subjectWise[sub];
        let pct = item.totalHeld > 0 ? ((item.present / item.totalHeld) * 100).toFixed(2) : 0;
        let pctColor = parseFloat(pct) >= 75 ? '#48bb78' : '#f56565';

        html += `
          <tr>
            <td style="text-align: left;"><b>${sub}</b></td>
            <td>${item.totalHeld}</td>
            <td style="color: #48bb78; font-weight: bold;">${item.present}</td>
            <td style="color: #f56565; font-weight: bold;">${item.absent}</td>
            <td style="color: ${pctColor}; font-weight: bold;">${pct}%</td>
          </tr>
        `;
      }

      html += `</tbody></table></div>`;
      resultDiv.innerHTML = html;

    } catch (e) {
      resultDiv.innerHTML = `<p style='color:#f56565;'>Server connection error!</p>`;
    }
  }

  // 4. Fetch Pending Teacher Registration Approvals
  async function loadPendingTeachers() {
    try {
      const res = await fetch('/api/hod/pending-teachers');
      const data = await res.json();
      
      if (data.success) {
        const teachers = data.teachers;
        const table = document.getElementById('pendingTable');
        const tbody = document.getElementById('pendingTeachersList');
        const noMsg = document.getElementById('noPendingMsg');
        
        tbody.innerHTML = '';
        
        if (!teachers || teachers.length === 0) {
          table.style.display = 'none';
          noMsg.style.display = 'block';
        } else {
          table.style.display = 'table';
          noMsg.style.display = 'none';
          
          teachers.forEach((t, idx) => {
            const subjectsStr = Array.isArray(t.subjects) ? t.subjects.join(', ') : '';
            tbody.innerHTML += `
              <tr>
                <td>${idx + 1}</td>
                <td><b>${t.name}</b></td>
                <td>${t.userId}</td>
                <td>${t.branch}</td>
                <td>${subjectsStr}</td>
                <td>
                  <button style="background: #38a169; color: white;" onclick="approveTeacher('${t.userId}')">Allow / Approve</button>
                </td>
              </tr>
            `;
          });
        }
      }
    } catch (err) {
      console.error("Error loading pending teachers:", err);
    }
  }

  // 5. Approve Teacher Account
  async function approveTeacher(userId) {
    if (!confirm(`Kya aap ${userId} ko teacher access dena chahte hain?`)) return;

    try {
      const res = await fetch('/api/hod/approve-teacher', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
      const data = await res.json();
      
      alert(data.message);
      if (data.success) {
        loadPendingTeachers(); // List ko refresh karega
      }
    } catch (err) {
      alert("Error: " + err.message);
    }
  }

  function exportHOD() {
    const branch = document.getElementById('filterBranch').value;
    const dateStr = document.getElementById('filterDate').value;
    window.location.href = `/api/attendance/export-sheet?role=HOD&branch=${branch}&dateStr=${dateStr}`;
  }

  // Initial Load
  fetchRecords();