const userService = require('../services/userService');
const adminService = require('../services/adminService');
const logService = require('../services/logService');

const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

exports.getUsers = async (req, res, next) => {
  try {
    const filters = {
      role: req.query.role,
      isOrganizer: req.query.isOrganizer === 'true' ? true
        : req.query.isOrganizer === 'false' ? false
          : undefined,
      deactivated: req.query.deactivated === 'true' ? true
        : req.query.deactivated === 'false' ? false
          : undefined,
      suspended: req.query.suspended === 'true' ? true
        : req.query.suspended === 'false' ? false
          : undefined,
      search: req.query.search,
    };
    const users = await userService.getAllUsers(filters);
    res.json(users);
  } catch (err) {
    next(err);
  }
};

exports.getUser = async (req, res, next) => {
  try {
    const user = await userService.getProfile(req.params.id);
    res.json(user);
  } catch (err) {
    next(err);
  }
};

exports.updateUser = async (req, res, next) => {
  try {
    const user = await adminService.updateUser(req.params.id, req.body, req.user.role);
    const submittedFields = Object.keys(req.body || {}).filter((k) => k !== 'password');
    logService.audit(req.user.email, 'update_user', user?.email || req.params.id, {
      type: 'user', adminId: req.user.id, targetRole: user?.role, submittedFields, ...ctx(req),
    });
    res.json(user);
  } catch (err) {
    next(err);
  }
};

exports.suspendUser = async (req, res, next) => {
  try {
    const user = await userService.suspendUser(req.params.id);
    logService.audit(req.user.email, 'suspend_user', user?.email || req.params.id, {
      type: 'user', adminId: req.user.id, targetRole: user?.role, ...ctx(req),
    });
    res.json(user);
  } catch (err) {
    next(err);
  }
};

exports.unsuspendUser = async (req, res, next) => {
  try {
    const user = await userService.unsuspendUser(req.params.id);
    logService.audit(req.user.email, 'unsuspend_user', user?.email || req.params.id, {
      type: 'user', adminId: req.user.id, targetRole: user?.role, ...ctx(req),
    });
    res.json(user);
  } catch (err) {
    next(err);
  }
};

exports.deleteUser = async (req, res, next) => {
  try {
    const result = await adminService.deleteUser(req.user.id, req.params.id);
    logService.audit(req.user.email, 'delete_user', req.params.id, {
      type: 'user', adminId: req.user.id, unresolvedRefunds: result.unresolvedRefunds, ...ctx(req),
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};

exports.toggleFavorite = async (req, res, next) => {
  try {
    const { eventId, action } = req.body || {};
    const result = await userService.toggleFavorite(req.user.id, eventId, action);
    res.json(result);
  } catch (err) {
    next(err);
  }
};

exports.getFavorites = async (req, res, next) => {
  try {
    const favorites = await userService.getFavorites(req.user.id);
    res.json({ favorites });
  } catch (err) {
    next(err);
  }
};
