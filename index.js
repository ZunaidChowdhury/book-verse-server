import dns from "node:dns/promises";
dns.setServers(["8.8.8.8", "1.1.1.1"]);

import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { MongoClient, ObjectId, ServerApiVersion } from 'mongodb';
import { createRemoteJWKSet, jwtVerify } from "jose";
import Stripe from "stripe";

const app = express();
dotenv.config();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
        const transactionCollection = database.collection("transaction");

        // get featured books [public]______________________________________________
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


        // get all books with search, filters, sorting, and pagination [public]
        app.get('/api/books', async (req, res) => {
            try {
                const {
                    search = '',
                    genres = '',
                    availability = 'all',
                    minPrice = '0',
                    maxPrice = '1000',
                    sort = 'newest',
                    page = '1',
                    limit = '9'
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

                // Pagination
                const pageNum = Math.max(parseInt(page) || 1, 1);
                const limitNum = Math.max(parseInt(limit) || 9, 1);
                const skip = (pageNum - 1) * limitNum;

                // Get total count for pagination metadata
                const totalBooks = await bookCollection.countDocuments(filter);
                const totalPages = Math.ceil(totalBooks / limitNum);

                // Execute query with filters, sort, and pagination
                const result = await bookCollection
                    .find(filter)
                    .sort(sortOrder)
                    .skip(skip)
                    .limit(limitNum)
                    .toArray();

                res.send({
                    books: result,
                    pagination: {
                        currentPage: pageNum,
                        totalPages,
                        totalBooks,
                        limit: limitNum,
                        hasNextPage: pageNum < totalPages,
                        hasPrevPage: pageNum > 1
                    }
                });
            } catch (error) {
                console.error('Error fetching books:', error);
                res.status(500).send({ error: true, message: error.message });
            }
        });

        // get a book [public] 
        app.get('/api/books/:bookId', async (req, res) => {
            const bookId = req.params.bookId;
            const book = await bookCollection.findOne({ _id: new ObjectId(bookId) });
            res.send(book);
        });

        // writer_____________________________________________________________________
        // post a book [protected, writer only]
        app.post('/api/books', verifyToken, verifyWriter, async (req, res) => {
            try {
                const { title, description, content, image, price, genres } = req.body;
                const { name: writerName, id: writerId } = req.user;

                // 1. Convert price to cents safely ($14.99 -> 1499)
                const priceInCents = Math.round(parseFloat(price) * 100);

                // 2. Automatically create the base product catalog entry on Stripe
                const stripeProduct = await stripe.products.create({
                    name: title,
                    description: description.substring(0, 500), // Stripe limits to 500 chars
                    images: [image],
                    metadata: { writerName, writerId }
                });

                // 3. Automatically attach the currency price model to that Stripe product
                const stripePrice = await stripe.prices.create({
                    product: stripeProduct.id,
                    unit_amount: priceInCents,
                    currency: 'usd',
                });

                // 4. Prepare your complete document object including the native Stripe track IDs
                const newBookDoc = {
                    ...req.body,
                    featuredPosition: 0,
                    writerName,
                    writerId,
                    price: parseFloat(price),
                    rating: 5.0,
                    soldQuantity: 0,

                    stripeProductId: stripeProduct.id,  // <-- Saved for reference
                    stripePriceId: stripePrice.id,      // <-- Saved for purchase checkout

                    createdAt: new Date(),
                    updatedAt: new Date()
                };

                // console.log("New Book Document to Insert:", newBookDoc);
                // 5. Insert directly into your plain MongoDB collection
                const result = await bookCollection.insertOne(newBookDoc);
                // console.log("MongoDB Insert Result:", result);

                res.status(201).send({
                    success: true,
                    insertedId: result.insertedId,
                    book: newBookDoc
                });

            } catch (error) {
                console.error("Stripe Automate Error:", error);
                res.status(500).send({ success: false, error: error.message });
            }
        });















        // _____________________________________________________________________
        // WRITER ENDPOINTS
        // _____________________________________________________________________

        // 1. Get own ebooks (Manage Ebooks list)
        app.get('/api/writer/my-books', verifyToken, verifyWriter, async (req, res) => {
            try {
                // Safely fetch writer identifier from verified JWT payload
                const writerId = req.user.id;

                const books = await bookCollection
                    .find({ writerId: writerId })
                    .sort({ _id: -1 }) // Newest first
                    .toArray();

                res.send(books);
            } catch (error) {
                console.error("Error fetching writer books:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });

        // 2. Update Ebook (Edit Ebook data or visibility status)
        app.patch('/api/writer/books/:bookId', verifyToken, verifyWriter, async (req, res) => {
            try {
                const bookId = req.params.bookId;
                const writerId = req.user.id;
                const updates = req.body;
                // console.log("Received update request for bookId:", bookId, "with updates:", updates);

                // Strip out restricted fields to prevent tampering
                delete updates._id;
                delete updates.writerId;
                delete updates.writerEmail;

                // Ensure the book belongs to the requesting writer
                const filter = { _id: new ObjectId(bookId), writerId: writerId };
                const updateDoc = { $set: updates };

                // console.log("Filter for update:", filter, "Update document:", updateDoc);
                const result = await bookCollection.updateOne(filter, updateDoc);

                if (result.matchedCount === 0) {
                    return res.status(404).send({ error: true, message: "Book not found or unauthorized" });
                }

                res.send({ success: true, message: "Book updated successfully", result });
            } catch (error) {
                console.error("Error updating book:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });

        // 3. Delete Ebook
        app.delete('/api/writer/books/:bookId', verifyToken, verifyWriter, async (req, res) => {
            try {
                const bookId = req.params.bookId;
                const writerId = req.user.id;

                const filter = { _id: new ObjectId(bookId), writerId: writerId };
                const result = await bookCollection.deleteOne(filter);

                if (result.deletedCount === 0) {
                    return res.status(404).send({ error: true, message: "Book not found or unauthorized" });
                }

                res.send({ success: true, message: "Book deleted successfully", result });
            } catch (error) {
                console.error("Error deleting book:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });

        // 4. Get Writer Sales History
        app.get('/api/writer/sales-history', verifyToken, verifyWriter, async (req, res) => {
            try {
                const writerId = req.user.id;
                const salesCollection = database.collection("sales"); // Setup context for sales tracking

                // Aggregate sales and resolve document joins natively
                const salesPipeline = [
                    { $match: { writerId: writerId } },
                    {
                        $lookup: {
                            from: "user",
                            localField: "buyerId",
                            foreignField: "_id", // standard lookup or matching fallback string
                            as: "buyerInfo"
                        }
                    },
                    { $unwind: { path: "$buyerInfo", preserveNullAndEmptyArrays: true } },
                    {
                        $project: {
                            _id: 1,
                            bookTitle: 1,
                            purchaseDate: 1,
                            amount: 1,
                            buyerName: { $ifNull: ["$buyerInfo.name", "$buyerEmail"] }
                        }
                    },
                    { $sort: { purchaseDate: -1 } }
                ];

                const salesHistory = await salesCollection.aggregate(salesPipeline).toArray();
                res.send(salesHistory);
            } catch (error) {
                console.error("Error fetching sales history:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });

        // _____________________________________________________________________
        // READER / PUBLIC WISHLIST ENDPOINTS
        // _____________________________________________________________________

        // 5. Get logged-in user's wishlist details (Gallery mapping)
        app.get('/api/wishlist', verifyToken, async (req, res) => {
            try {
                const userId = req.user.id;
                const wishlistCollection = database.collection("wishlist");

                // Aggregate to pull complete book objects straight into the wishlist payload
                const pipeline = [
                    { $match: { userId: userId } },
                    {
                        $lookup: {
                            from: "book",
                            localField: "bookId",
                            foreignField: "_id",
                            as: "bookDetails"
                        }
                    },
                    { $unwind: "$bookDetails" },
                    { $replaceRoot: { newRoot: "$bookDetails" } } // Directly gives an array of book models
                ];

                const wishlistBooks = await wishlistCollection.aggregate(pipeline).toArray();
                res.send(wishlistBooks);
            } catch (error) {
                console.error("Error fetching wishlist:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });



















        // reader______________________________________________________________________________________
        app.post('/api/checkout/create-session', verifyToken, verifyReader, async (req, res) => {
            console.log('Received checkout session request with body:', req.body);
            try {
                const { bookId } = req.body;

                // Pull the book target document straight from MongoDB
                const book = await bookCollection.findOne({ _id: new ObjectId(bookId) });

                if (!book || !book.stripePriceId) {
                    console.log("Book not found or missing Stripe price association:", book);
                    return res.status(404).send({ error: "Missing automated Stripe price association." });
                }

                // Initialize the Stripe remote session tracking
                const session = await stripe.checkout.sessions.create({
                    mode: 'payment',
                    line_items: [
                        {
                            price: book.stripePriceId, // Use the ID created in Step 1
                            quantity: 1,
                        },
                    ],

                    metadata: {
                        bookId: bookId,
                        userId: req.user.id,
                        buyerName: req.user.name,
                        buyerEmail: req.user.email,
                        bookTitle: book.title,
                    },

                    success_url: `${process.env.CLIENT_URL}/books/${bookId}?status=success`,
                    cancel_url: `${process.env.CLIENT_URL}/books/${bookId}?status=cancelled`,
                });
                console.log("Checkout session created:", session.url);
                res.send({ url: session.url });
            } catch (error) {
                console.error("Error creating checkout session:", error);
                res.status(500).send({ error: error.message });
            }
        });

        app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
            console.log('=== WEBHOOK RECEIVED ===');
            console.log('Received Stripe webhook event');
            const sig = req.headers['stripe-signature'];
            console.log('Signature present:', !!sig);
            console.log('Webhook secret configured:', !!process.env.STRIPE_WEBHOOK_SECRET);
            let event;

            try {
                // Verify that the request actually came from Stripe
                console.log('Attempting to construct event...');
                event = stripe.webhooks.constructEvent(
                    req.body,
                    sig,
                    process.env.STRIPE_WEBHOOK_SECRET // Get this from Stripe CLI or Dashboard
                );
                console.log('✓ Event verified successfully');
            } catch (err) {
                console.error(`✗ Webhook Signature Verification Failed:`, err.message);
                return res.status(400).send(`Webhook Error: ${err.message}`);
            }

            console.log('Event type:', event.type);
            console.log('Event session/object id:', event.data.object.id);
            
            // Handle the specific successful payment event
            if (event.type === 'checkout.session.completed') {
                console.log('✓ Processing checkout.session.completed event');
                const session = event.data.object;

                // Extract the variables we stashed in metadata earlier
                const { userId, buyerName, buyerEmail, bookTitle, bookId } = session.metadata;
                console.log('Metadata:', { userId, buyerName, buyerEmail, bookTitle, bookId });
                const amountPaid = session.amount_total / 100; // Stripe provides this in cents (e.g., 1000 = $10.00)

                try {
                    const newTransaction = {
                        buyerName: buyerName,
                        buyerEmail: buyerEmail,
                        bookTitle: bookTitle,
                        amount: amountPaid,
                        paymentDate: new Date(),
                        type: 'purchase',
                        buyerId: userId,
                        bookId: bookId,
                        stripeSessionId: session.id,
                    };
                    console.log('Attempting to save transaction:', newTransaction);
                    
                    const result = await transactionCollection.insertOne(newTransaction);
                    console.log(`✓ Transaction saved successfully for Book ID: ${bookId}, Tx ID: ${result.insertedId}`);

                    // OPTIONAL: Update user collection here to give them instant library access
                    // await userCollection.updateOne({ _id: new ObjectId(userId) }, { $push: { purchasedBooks: bookId } });

                } catch (dbError) {
                    console.error("✗ Failed to insert transaction into DB:", dbError);
                    // Return a 500 so Stripe knows your server failed and will retry sending the event
                    return res.status(500).send("Database insertion failed");
                }
            } else {
                console.log(`Webhook event type '${event.type}' - no action needed`);
            }

            // Return a 200 response to Stripe to acknowledge receipt of the event
            console.log('=== WEBHOOK COMPLETE ===\n');
            res.json({ received: true });
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
        app.get('/api/users', verifyToken, async (req, res) => {
            // console.log('Received request to fetch users:', req.user);
            const cursor = userCollection.find();
            const result = await cursor.toArray();
            res.send(result);
        });

        // app.get('/protected-message', verifyToken, async (req, res) => {
        //     // res.send(result);
        //     res.json({ message: 'protected messaged accessed' });


        // });

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
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





















