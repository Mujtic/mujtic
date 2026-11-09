// ===============================================
// CONFIGURATION + GLOBAL DATA
// ===============================================

const API_BASE = 'https://glycr.onrender.com/api';
let authToken = null;
let currentAdmin = { name: 'Admin', email: '', role: '' };

let users           = [];
let events          = [];
let tickets         = [];
let payouts         = [];
let refunds         = [];
let waitlist        = [];
let logs            = [];
let serviceRequests = [];
let messages        = [];
let transactions    = [];
let stats           = {};
let platformFeePercent = 0;
let platformFeeFloor   = 0;
let processingFeePercent = 0;
let processingFeeFloor   = 0;

const selectedIds = {
  users: new Set(),
  events: new Set(),
  tickets: new Set(),
  payouts: new Set(),
  refunds: new Set(),
  waitlist: new Set(),
  'service-requests': new Set(),
  messages: new Set(),
  transactions: new Set(),
};

const sortState = {};

const pageState = {
  users: 1, events: 1, tickets: 1, payouts: 1,
  refunds: 1, waitlist: 1, 'service-requests': 1, messages: 1,
  transactions: 1,
};
const perPage = {
  users: 20, events: 20, tickets: 20, payouts: 20,
  refunds: 20, waitlist: 20, 'service-requests': 20, messages: 20,
  transactions: 20,
};

let chartRevenue = null;
let chartTickets = null;
let chartUsers   = null;
let currentChartPeriod = 'daily';
