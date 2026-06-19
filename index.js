import express from "express";
import cors from "cors";
import dotenv from "dotenv";

const app = express();
dotenv.config();

const port = process.env.PORT || 5001;


// MIDDLEWARES
app.use(cors());
app.use(express.json());


// ROUTES
app.get('/', (req, res) => {
    res.send('Server is live...');
})

app.listen(port, () => {
    console.log(`Server is running on port: ${port}`)
})