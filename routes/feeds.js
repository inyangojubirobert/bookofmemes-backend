import express from "express";
import cors from "cors";
import feedsRouter from "./routes/feeds.js"; // default export

const app = express();
app.use(cors());
app.use(express.json());

// 🔹 Use the feeds router
app.use("/feeds", feedsRouter);

// 🔹 Basic health check
app.get("/", (req, res) => res.send("Book of Memes API is running"));

// 🔹 Start server
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
