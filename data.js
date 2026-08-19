const defaultDepartments=[{name:"Operations",parent:""},{name:"Wagon Team",parent:"Operations"},{name:"Technical",parent:""},{name:"ICT",parent:""},{name:"HSE",parent:""},{name:"Supervisors",parent:""}];
const defaultWorkers=[
{id:1,employeeNo:"WK001",name:"John Kamau",department:"Operations",classification:"Skilled",rate:200,otRate:250,joinDate:"2026-01-01",active:true,client:"",assignment:"",deploymentStart:""},
{id:2,employeeNo:"WK002",name:"Peter Mwangi",department:"Technical",classification:"Skilled",rate:200,otRate:250,joinDate:"2026-01-05",active:true,client:"",assignment:"",deploymentStart:""},
{id:3,employeeNo:"WK003",name:"Mary Wanjiku",department:"HSE",classification:"Unskilled",rate:150,otRate:180,joinDate:"2026-02-01",active:true,client:"",assignment:"",deploymentStart:""},
{id:4,employeeNo:"WK004",name:"David Otieno",department:"ICT",classification:"Skilled",rate:200,otRate:250,joinDate:"2026-02-10",active:true,client:"",assignment:"",deploymentStart:""},
{id:5,employeeNo:"WK005",name:"James Kariuki",department:"Supervisors",classification:"Supervisor",rate:250,otRate:300,joinDate:"2026-01-15",active:true,client:"",assignment:"",deploymentStart:""}
];
const defaultClients=[{id:1,name:"ABC Manufacturing",contact:"Grace Njeri",phone:"0712 000 001",active:true},{id:2,name:"XYZ Logistics",contact:"Brian Otieno",phone:"0722 000 002",active:true}];
const defaultRequests=[{id:1,requestNo:"LR-0001",clientId:1,department:"Operations",workersRequired:8,classification:"Skilled",startDate:"2026-08-20",duration:5,shift:"Day",notes:"Increased production workload",status:"Pending",allocatedWorkerIds:[],createdAt:"2026-08-18T10:00:00Z"}];
let workers=JSON.parse(localStorage.getItem("labourforce_workers"))||defaultWorkers;
let departments=JSON.parse(localStorage.getItem("labourforce_departments"))||defaultDepartments;
let clients=JSON.parse(localStorage.getItem("labourforce_clients"))||defaultClients;
let labourRequests=JSON.parse(localStorage.getItem("labourforce_requests"))||defaultRequests;
let attendance=JSON.parse(localStorage.getItem("labourforce_attendance"))||{};
let payroll=JSON.parse(localStorage.getItem("labourforce_payroll"))||{};
function saveData(){localStorage.setItem("labourforce_workers",JSON.stringify(workers));localStorage.setItem("labourforce_departments",JSON.stringify(departments));localStorage.setItem("labourforce_clients",JSON.stringify(clients));localStorage.setItem("labourforce_requests",JSON.stringify(labourRequests));localStorage.setItem("labourforce_attendance",JSON.stringify(attendance));localStorage.setItem("labourforce_payroll",JSON.stringify(payroll));}
