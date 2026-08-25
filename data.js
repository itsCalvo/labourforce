const defaultDepartments=[{name:"Operations",parent:"",rate:0,otRate:0},{name:"Wagon Team",parent:"Operations",rate:0,otRate:0},{name:"Technical",parent:"",rate:0,otRate:0},{name:"ICT",parent:"",rate:0,otRate:0},{name:"HSE",parent:"",rate:0,otRate:0},{name:"Supervisors",parent:"",rate:0,otRate:0}];
const defaultWorkers=[
{id:1,employeeNo:"WK001",idNumber:"ID-1001",name:"John Kamau",department:"Operations",designation:"Operator",classification:"Skilled",rate:200,otRate:250,joinDate:"2026-01-01",active:true,client:"",assignment:"",deploymentStart:""},
{id:2,employeeNo:"WK002",idNumber:"ID-1002",name:"Peter Mwangi",department:"Technical",designation:"Technician",classification:"Skilled",rate:200,otRate:250,joinDate:"2026-01-05",active:true,client:"",assignment:"",deploymentStart:""},
{id:3,employeeNo:"WK003",idNumber:"ID-1003",name:"Mary Wanjiku",department:"HSE",designation:"Safety Officer",classification:"Unskilled",rate:150,otRate:180,joinDate:"2026-02-01",active:true,client:"",assignment:"",deploymentStart:""},
{id:4,employeeNo:"WK004",idNumber:"ID-1004",name:"David Otieno",department:"ICT",designation:"Support",classification:"Skilled",rate:200,otRate:250,joinDate:"2026-02-10",active:true,client:"",assignment:"",deploymentStart:""},
{id:5,employeeNo:"WK005",idNumber:"ID-1005",name:"James Kariuki",department:"Supervisors",designation:"Supervisor",classification:"Supervisor",rate:250,otRate:300,joinDate:"2026-01-15",active:true,client:"",assignment:"",deploymentStart:""}
];
const defaultClients=[{id:1,name:"ABC Manufacturing",contact:"Grace Njeri",phone:"0712 000 001",active:true},{id:2,name:"XYZ Logistics",contact:"Brian Otieno",phone:"0722 000 002",active:true}];
const defaultRequests=[{id:1,requestNo:"LR-0001",clientId:1,department:"Operations",workersRequired:8,classification:"Skilled",startDate:"2026-08-20",duration:5,shift:"Day",notes:"Increased production workload",status:"Pending",allocatedWorkerIds:[],createdAt:"2026-08-18T10:00:00Z"}];
const defaultJtsState={disputes:[],corrections:[],deductions:[],payroll:{}};
let workers=JSON.parse(localStorage.getItem("labourforce_workers"))||defaultWorkers;
let departments=JSON.parse(localStorage.getItem("labourforce_departments"))||defaultDepartments;
let clients=JSON.parse(localStorage.getItem("labourforce_clients"))||defaultClients;
let labourRequests=JSON.parse(localStorage.getItem("labourforce_requests"))||defaultRequests;
let attendance=JSON.parse(localStorage.getItem("labourforce_attendance"))||{};
let payroll=JSON.parse(localStorage.getItem("labourforce_payroll"))||{};
let jtsState=JSON.parse(localStorage.getItem("labourforce_jts_state"))||defaultJtsState;
let jtsDeductionRates=JSON.parse(localStorage.getItem("labourforce_jts_deduction_rates"))||{nssf:6,housing:1.5,shif:0.5,paye:10};

/* Bumped on every mutation so memoized views (dashboard, payroll)
   know when their cached computations are stale. */
let lfDataVersion=0;

function normalizeLocalMasterData(){
 const departmentMap=new Map();
 departments.forEach(d=>{const name=String(d.name||'').replace(/\s+/g,' ').trim();if(name&&!departmentMap.has(name.toLowerCase()))departmentMap.set(name.toLowerCase(),{...d,name});});
 departments=[...departmentMap.values()];
 const workerMap=new Map();
 workers.forEach(w=>{const key=String(w.idNumber||`${w.name}|${w.phone||''}`).replace(/\s+/g,' ').trim().toLowerCase();if(key&&!workerMap.has(key))workerMap.set(key,w);});
 workers=[...workerMap.values()];
 const staffNos=new Set();
 workers.forEach(w=>{const base=String(w.employeeNo||'').trim()||`WK${String(w.id).replace(/\D/g,'').slice(-6)}`;let value=base, suffix=1;while(staffNos.has(value.toLowerCase()))value=`${base}-${suffix++}`;w.employeeNo=value;staffNos.add(value.toLowerCase());});
}
normalizeLocalMasterData();

/* Date-scoped cloud-sync tracking. Attendance mutators record the exact
   dates they touched so the sync layer pushes only those rows instead of
   re-uploading the entire attendance history every time. */
const LF_ATT_DIRTY_KEY='labourforce_attendance_dirty_dates';
function markAttendanceDirtyDate(date){
 if(!date)return;
 try{
   const list=JSON.parse(localStorage.getItem(LF_ATT_DIRTY_KEY)||'[]');
   if(!list.includes(date)){list.push(date);localStorage.setItem(LF_ATT_DIRTY_KEY,JSON.stringify(list.slice(-500)));}
 }catch(e){/* storage unavailable - full sync flag still covers it */}
}
function takeAttendanceDirtyDates(){
 try{
   const list=JSON.parse(localStorage.getItem(LF_ATT_DIRTY_KEY)||'[]');
   localStorage.removeItem(LF_ATT_DIRTY_KEY);
   return Array.isArray(list)?list:[];
 }catch(e){return[];}
}

let saveDataTimer=null;
function saveData(){
 if(/renderDashboard|renderAttendance|renderApproval|renderJtsAttendance|renderJtsHistory|renderJtsPayroll|renderWorkers/.test(new Error().stack||''))return;
 lfDataVersion++;
 localStorage.setItem("labourforce_jts_deduction_rates",JSON.stringify(jtsDeductionRates)); clearTimeout(saveDataTimer);
 saveDataTimer=setTimeout(()=>{localStorage.setItem("labourforce_workers",JSON.stringify(workers));localStorage.setItem("labourforce_departments",JSON.stringify(departments));localStorage.setItem("labourforce_clients",JSON.stringify(clients));localStorage.setItem("labourforce_requests",JSON.stringify(labourRequests));localStorage.setItem("labourforce_attendance",JSON.stringify(attendance));localStorage.setItem("labourforce_payroll",JSON.stringify(payroll));localStorage.setItem("labourforce_jts_state",JSON.stringify(jtsState));},150);
}