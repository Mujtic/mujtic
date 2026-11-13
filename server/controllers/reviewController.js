const reviewService = require('../services/reviewService');

exports.createReview = async (req, res, next) => {
  try {
    const review = await reviewService.createReview(req.user?.id, req.body);
    res.status(201).json(review);
  } catch (err) {
    next(err);
  }
};

exports.getMyReviews = async (req, res, next) => {
  try {
    res.json(await reviewService.getMyReviews(req.user?.id));
  } catch (err) {
    next(err);
  }
};

exports.getOrganizerReviews = async (req, res, next) => {
  try {
    if (!req.user?.isOrganizer && !req.user?.isAdmin) {
      throw new (require('../utils/appError').AppError)('Forbidden', 403);
    }
    const data = await reviewService.getOrganizerReviews(req.user.id);
    res.json(data);
  } catch (err) {
    next(err);
  }
};
