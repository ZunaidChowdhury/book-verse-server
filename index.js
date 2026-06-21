import dns from "node:dns/promises";
dns.setServers(["8.8.8.8", "1.1.1.1"]);



import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { MongoClient, ObjectId, ServerApiVersion } from 'mongodb';
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
dotenv.config();

const uri = process.env.MONGODB_URI;
const port = process.env.PORT || 5001;


// MIDDLEWARES
app.use(cors());
app.use(express.json());

const JWKS = createRemoteJWKSet(
    new URL(`${process.env.CLIENT_URL}/api/auth/jwks`)
)

const verifyToken = async (req, res, next) => {
    const authHeader = req?.headers.authorization
    if (!authHeader) {
        return res.status(401).json({ message: 'Unauthorized' })
    }
    const token = authHeader.split(' ')[1]
    if (!token) {
        return res.status(401).json({ message: 'Unauthorized' })
    }
    // console.log(token);
    try {
        const { payload } = await jwtVerify(token, JWKS)
        // console.log('server/jwt/payload: ', payload);
        req.user = payload;
        next()


    } catch (error) {
        return res.status(403).json({ message: 'Forbidden' });
    }


}

// must be used after verifyToken middleware
const verifyReader = async (req, res, next) => {
    if (req.user?.role !== 'reader') {
        return res.status(403).send({ message: 'forbidden access' })
    }
    next();
}

// must be used after verifyToken middleware
const verifyWriter = async (req, res, next) => {
    if (req.user?.role !== 'writer') {
        return res.status(403).send({ message: 'forbidden access' })
    }
    next();
}

// must be used after verifyToken middleware
const verifyAdmin = async (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' })
    }
    next();
}

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server (optional starting in v4.7)        

        // await client.connect();
        const database = client.db("BookVerse");
        const userCollection = database.collection("user");
        const bookCollection = database.collection("book");

        // get featured books [public]
        app.get('/api/featured-books', async (req, res) => {
            const cursor = bookCollection.find({ featuredPosition: { $gte: 1, $lte: 8 } }).sort({ featuredPosition: 1 });
            const result = await cursor.toArray();

            res.send(result);
        });

        // get top-writers [public]
        app.get('/api/top-writers', async (req, res) => {
            try {
                const pipeline = [
                    // Step 1: Filter to get only users who are writers
                    {
                        $match: { role: "writer" }
                    },
                    // Step 2: Sort by totalSales field in descending order (-1)
                    {
                        $sort: { totalSales: -1 }
                    },
                    // Step 3: Restrict the final array output to exactly 3 documents
                    {
                        $limit: 3
                    }
                ];

                // Execute the aggregation query on your collection
                const result = await userCollection.aggregate(pipeline).toArray();

                res.send(result);
            } catch (error) {
                console.error("Error fetching top writers:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });


        // get all books with search, filters, and sorting [public]
        app.get('/api/books', async (req, res) => {
            try {
                const {
                    search = '',
                    genres = '',
                    availability = 'all',
                    minPrice = '0',
                    maxPrice = '1000',
                    sort = 'newest'
                } = req.query;

                // Build filter object
                const filter = {};

                // Search filter for title and writer name (case-insensitive)
                if (search.trim()) {
                    filter.$or = [
                        { title: { $regex: search.trim(), $options: 'i' } },
                        { writerName: { $regex: search.trim(), $options: 'i' } }
                    ];
                }

                // Genre filter (support multiple genres)
                if (genres.trim()) {
                    const genreArray = genres.split(',').map(g => g.trim()).filter(Boolean);
                    if (genreArray.length > 0) {
                        filter.genres = { $in: genreArray };
                    }
                }

                // Availability filter
                if (availability !== 'all') {
                    if (availability === 'in-stock') {
                        filter.availabilityStatus = 'Available';
                    } else if (availability === 'sold') {
                        filter.availabilityStatus = 'Sold Out';
                    }
                }

                // Price range filter
                const min = parseInt(minPrice) || 0;
                const max = parseInt(maxPrice) || 1000;
                filter.price = { $gte: min, $lte: max };

                // Determine sort order
                let sortOrder = {};
                switch (sort) {
                    case 'price-low':
                        sortOrder = { price: 1 }; // ascending
                        break;
                    case 'price-high':
                        sortOrder = { price: -1 }; // descending
                        break;
                    case 'rating':
                        sortOrder = { rating: -1 }; // highest first
                        break;
                    case 'newest':
                    default:
                        sortOrder = { _id: -1 }; // newest (most recent ObjectId first)
                        break;
                }

                // Execute query with filters and sort
                const cursor = bookCollection.find(filter).sort(sortOrder);
                const result = await cursor.toArray();

                res.send(result);
            } catch (error) {
                console.error('Error fetching books:', error);
                res.status(500).send({ error: true, message: error.message });
            }
        });



        // writer
        // post a book [protected, writer only]
        app.post('/api/books', verifyToken, verifyWriter, async (req, res) => {
            const newBook = req.body;
            const result = await bookCollection.insertOne(newBook);
            res.send(result);
        });




        // test user preference [private]
        app.patch('/api/user/preference', verifyToken, async (req, res) => {
            // console.log('server body: ', req.body)
            // console.log('verified user payload: ', req.user)

            const userId = req.user.id;
            if (!userId) {
                return res.status(400).json({ message: 'Unable to resolve user ID from token payload' });
            }

            const updatedData = req.body;
            const result = await userCollection.updateOne({ _id: new ObjectId(userId) }, { $set: updatedData });
            res.send(result);
        });

        // test get users
        app.get('/api/users', verifyToken, verifyAdmin, async (req, res) => {
            const cursor = userCollection.find();
            const result = await cursor.toArray();
            res.send(result);
        });

        // app.get('/protected-message', verifyToken, async (req, res) => {
        //     // res.send(result);
        //     res.json({ message: 'protected messaged accessed' });


        // });

        // Send a ping to confirm a successful connection
        // await client.db("admin").command({ ping: 1 });
        // console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);

// ROUTES
app.get('/', (req, res) => {
    res.send('Server is live...');
})

app.listen(port, () => {
    console.log(`Server is running on port: ${port}`)
})