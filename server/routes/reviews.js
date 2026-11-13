const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const reviewController = require('../controllers/reviewController');
const { requireOrganizer } = require('../middleware/rbac');


router.get('/reviews/my', auth, reviewController.getMyReviews);
router.post('/reviews',   auth, reviewController.createReview);

router.get('/reviews/organizer', auth, requireOrganizer, reviewController.getOrganizerReviews);

module.exports = router;
