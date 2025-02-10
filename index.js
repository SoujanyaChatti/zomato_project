const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3000;

// Set strictQuery to false to handle the deprecation warning
mongoose.set('strictQuery', false);

// Configure multer for image upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = 'uploads';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// Configure Gemini
const GEMINI_API_KEY = "AIzaSyC8ku9Cr2r5lv5wY0f7rQNJhrf91Rvbz1Y"; // Replace with your actual API key
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Helper function to convert image to base64
async function fileToGenerativePart(path, mimeType) {
  const data = await fs.promises.readFile(path);
  return {
    inlineData: {
      data: Buffer.from(data).toString('base64'),
      mimeType
    }
  };
}

// MongoDB connection
mongoose
  .connect(
    "mongodb+srv://ramasoujanya9:fY7NOTdvRddslRIq@cluster0.wfk1l.mongodb.net/zomato_db",
    {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    }
  )
  .then(() => {
    console.log("Connected to MongoDB");

    // Define schema
    const restaurantSchema = new mongoose.Schema({
      _id: mongoose.Schema.Types.ObjectId,
      id: String,
      name: String,
      location: {
        locality: String,
        city: String,
        address: String,
        zipcode: String,
        latitude: String,
        longitude: String,
      },
      user_rating: {
        aggregate_rating: String,
        rating_text: String,
        votes: String,
        rating_color: String,
      },
      price_range: Number,
      average_cost_for_two: Number,
      has_online_delivery: Number,
      has_table_booking: Number,
      is_delivering_now: Number,
      cuisines: String,
      featured_image: String,
      thumb: String,
      url: String,
      menu_url: String,
      events_url: String,
    });

    // Define model
    const Restaurant = mongoose.model("Restaurant", restaurantSchema);

    // Function to get unique cuisines
    async function getUniqueCuisines() {
      try {
        const restaurants = await Restaurant.find({}, 'cuisines');
        const uniqueCuisines = new Set();
        
        restaurants.forEach(restaurant => {
          if (restaurant.cuisines) {
            const cuisineList = restaurant.cuisines.split(',').map(c => c.trim());
            cuisineList.forEach(cuisine => uniqueCuisines.add(cuisine));
          }
        });
        
        return Array.from(uniqueCuisines).sort();
      } catch (error) {
        console.error('Error getting unique cuisines:', error);
        return [];
      }
    }

    // Image upload and analysis endpoint
    app.post("/upload-image", upload.single("image"), async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "No image uploaded" });
        }

        // Get unique cuisines from database
        const availableCuisines = await getUniqueCuisines();
        
        // Get the Gemini Pro Vision model
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        // Convert image to generative part
        const mimeType = req.file.mimetype;
        const imagePart = await fileToGenerativePart(req.file.path, mimeType);
        
        // Create prompt
        const prompt = `Analyze this food image and identify which cuisines it belongs to from the following list: ${availableCuisines.join(', ')}
        
        Important instructions:
        1. Consider the ingredients, presentation, and cooking style visible in the image
        2. Look for distinctive features that match specific cuisines
        3. Return EXACTLY three most relevant cuisines as a comma-separated list
        4. If you're not completely sure, include similar cuisine types from the provided list
        5. Only use cuisines from the provided list`;

        // Generate response
        const result = await model.generateContent([prompt, imagePart]);
        const response = await result.response;
        const predictions = response.text().split(',').map(c => c.trim()).slice(0, 3);

        // Clean up uploaded file
        fs.unlinkSync(req.file.path);

        // Return predictions
        res.json({ cuisines: predictions });
      } catch (error) {
        console.error("Error analyzing image:", error);
        res.status(500).json({ error: "Error analyzing image", details: error.message });
      }
    });

    // Haversine formula
    function haversine(lat1, lon1, lat2, lon2) {
      const R = 6371;
      const dLat = (lat2 - lat1) * (Math.PI / 180);
      const dLon = (lon2 - lon1) * (Math.PI / 180);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) *
        Math.cos(lat2 * (Math.PI / 180)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    }

    // Modified restaurants endpoint with cuisine filtering
    app.get("/restaurants", async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 15;
        const skip = (page - 1) * limit;
        
        const userLat = parseFloat(req.query.lat);
        const userLon = parseFloat(req.query.lon);
        const cuisines = req.query.cuisines ? req.query.cuisines.split(',') : null;
        
        let query = {};
        
        // Add cuisine filter if present
        if (cuisines && cuisines.length > 0) {
          const cuisineRegex = cuisines.map(c => 
            new RegExp(c.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
          );
          query.cuisines = { $in: cuisineRegex };
        }

        // If location is available, filter by distance
        if (!isNaN(userLat) && !isNaN(userLon)) {
          const allRestaurants = await Restaurant.find(query);
          const maxDistance = 10; // 10 km
          
          const filteredRestaurants = allRestaurants.filter((restaurant) => {
            const restLat = parseFloat(restaurant.location.latitude);
            const restLon = parseFloat(restaurant.location.longitude);
            if (isNaN(restLat) || isNaN(restLon)) return false;
            const distance = haversine(userLat, userLon, restLat, restLon);
            return distance <= maxDistance;
          });

          const paginatedRestaurants = filteredRestaurants.slice(skip, skip + limit);
          
          res.json({
            restaurants: paginatedRestaurants,
            total: filteredRestaurants.length,
            page,
            totalPages: Math.ceil(filteredRestaurants.length / limit),
          });
        } else {
          // If no location, return filtered restaurants with pagination
          const total = await Restaurant.countDocuments(query);
          const restaurants = await Restaurant.find(query)
            .skip(skip)
            .limit(limit);

          res.json({
            restaurants,
            total,
            page,
            totalPages: Math.ceil(total / limit),
          });
        }
      } catch (error) {
        console.error("Error retrieving restaurants:", error);
        res.status(500).json({ error: "Error retrieving restaurants" });
      }
    });

    // Restaurant detail routes
    app.get("/restaurant/:id", (req, res) => {
      res.sendFile(path.join(__dirname, "public", "restaurant.html"));
    });

    app.get("/api/restaurant/:id", async (req, res) => {
      try {
        const restaurantId = req.params.id;
        const restaurant = await Restaurant.findById(restaurantId);

        if (!restaurant) {
          return res.status(404).json({ error: "Restaurant not found" });
        }

        res.json(restaurant);
      } catch (err) {
        res.status(500).json({ error: "Error fetching restaurant details" });
      }
    });

    // Serve static files
    app.use(express.static("public"));

    // Start server
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
  });