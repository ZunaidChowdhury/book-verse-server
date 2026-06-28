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
app.use(
    express.json({
        verify: (req, res, buf) => {
            // If it is the stripe webhook route, attach the raw buffer to req.rawBody
            if (req.originalUrl.startsWith('/api/webhooks/stripe')) {
                req.rawBody = buf;
            }
        }
    })
);

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
        const bookContentCollection = database.collection("bookContent");

        // STRIPE WEBHOOK ENDPOINT____________________________________________________________
        app.post('/api/webhooks/stripe', async (req, res) => {
            const sig = req.headers['stripe-signature'];
            let event;

            try {
                event = stripe.webhooks.constructEvent(
                    req.rawBody,
                    sig,
                    process.env.STRIPE_WEBHOOK_SECRET
                );
            } catch (err) {
                console.error(`Webhook Error: ${err.message}`);
                return res.status(400).send(`Webhook Error: ${err.message}`);
            }

            if (event.type === 'checkout.session.completed') {
                const session = event.data.object;

                const userId = session.metadata?.userId;
                const userName = session.metadata?.userName;
                const userEmail = session.metadata?.userEmail;
                const bookId = session.metadata?.bookId;
                const bookTitle = session.metadata?.bookTitle;
                const writerId = session.metadata?.writerId;
                // console.log('Stripe webhook session metadata 2:', session.metadata);
                const transactionDoc = {
                    stripeSessionId: session.id,
                    paymentIntentId: session.payment_intent,

                    userId,
                    userName,
                    userEmail,
                    bookId,
                    bookTitle,
                    writerId,
                    amountPaid: session.amount_total / 100,
                    type: 'purchase',
                    currency: session.currency,
                    paymentStatus: session.payment_status,
                    purchasedAt: new Date(),

                };
                // console.log('Stripe webhook session metadata 3:', session.metadata);
                try {
                    // Save transaction
                    const transactionResult = await transactionCollection.insertOne(transactionDoc);
                    console.log(`Transaction successfully recorded in MongoDB: ${transactionResult.insertedId}`);

                    // Update book soldQuantity
                    const bookUpdateResult = await bookCollection.updateOne(
                        { _id: new ObjectId(bookId) },
                        { $inc: { soldQuantity: 1 } }
                    );
                    console.log(`Book soldQuantity updated: ${bookUpdateResult.modifiedCount} document(s) modified`);
                } catch (dbError) {
                    console.error("Failed to save transaction or update book:", dbError);
                }
            }

            res.json({ received: true });
        });




        // PUBLIC ENDPOINT____________________________________________________________
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
                    // Group book stats by writer
                    {
                        $group: {
                            _id: '$writerId',
                            writerName: { $first: '$writerName' },
                            booksCount: { $sum: 1 },
                            sales: { $sum: '$soldQuantity' }
                        }
                    },
                    // Lookup writer profile data from the user collection
                    {
                        $lookup: {
                            from: 'user',
                            let: { writerId: '$_id' },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: {
                                            $eq: [{ $toString: '$_id' }, '$$writerId']
                                        }
                                    }
                                },
                                {
                                    $project: {
                                        name: 1,
                                        image: 1,
                                        role: 1,
                                        socials: 1,
                                        bio: 1
                                    }
                                }
                            ],
                            as: 'writerProfile'
                        }
                    },
                    {
                        $unwind: {
                            path: '$writerProfile',
                            preserveNullAndEmptyArrays: true
                        }
                    },
                    {
                        $project: {
                            _id: '$_id',
                            name: {
                                $ifNull: ['$writerProfile.name', '$writerName']
                            },
                            image: '$writerProfile.image',
                            role: '$writerProfile.role',
                            socials: '$writerProfile.socials',
                            booksCount: 1,
                            sales: 1
                        }
                    },
                    {
                        $sort: { sales: -1 }
                    },
                    {
                        $limit: 3
                    }
                ];

                const result = await bookCollection.aggregate(pipeline).toArray();
                res.send(result);
            } catch (error) {
                console.error('Error fetching top writers:', error);
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

                // Genre filter (support multiple genres case-insensitively)
                if (genres.trim()) {
                    // Split incoming query but preserve casing patterns to parse correctly
                    const genreArray = genres.split(',').map(g => g.trim()).filter(Boolean);

                    if (genreArray.length > 0) {
                        // Map each requested genre text into a clean exact-match case-insensitive regex
                        const caseInsensitiveQueries = genreArray.map(genre => ({
                            genres: { $regex: `^${genre}$`, $options: 'i' }
                        }));

                        // Securely bind the conditions to your main filter payload wrapper object
                        if (filter.$or) {
                            // If the search filter already populated $or, use $and to merge genre rules
                            filter.$and = [
                                { $or: filter.$or },
                                { $or: caseInsensitiveQueries }
                            ];
                            delete filter.$or; // Remove root $or to prevent conflict issues
                        } else {
                            // Standard placement if search query is blank
                            filter.$or = caseInsensitiveQueries;
                        }
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
            try {
                const book = await bookCollection.findOne({ _id: new ObjectId(bookId) });
                if (!book) {
                    return null;
                }
                res.send(book);
            } catch (error) {
                console.error("Server API Error:", error.message);
                return null;
            }

        });




        // WRITER PUBLIC ENDPOINT____________________________________________________________
        // post a book [protected, writer only]
        app.post('/api/books', verifyToken, verifyWriter, async (req, res) => {
            console.log('server/post/book/body: ', req.body)
            try {
                // Separate content from book metadata so content isn't stored in the main book collection
                const { content, price, title, description, image } = req.body;
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

                // 4. Prepare your complete document object excluding `content`
                const { content: _c, ...rest } = req.body;
                const newBookDoc = {
                    ...rest,
                    featuredPosition: 0,
                    writerName,
                    writerId,
                    price: parseFloat(price),
                    rating: 5.0,
                    soldQuantity: 0,

                    stripeProductId: stripeProduct.id,
                    stripePriceId: stripePrice.id,

                    createdAt: new Date(),
                    updatedAt: new Date()
                };


                if (Array.isArray(newBookDoc?.genres)) {
                    // Loop through, trim whitespace, and convert to lowercase
                    newBookDoc.genres = newBookDoc.genres.map(genre =>
                        genre.toLowerCase().trim()
                    );
                }


                // 5. Insert into book collection (no `content` field)
                const result = await bookCollection.insertOne(newBookDoc);

                // 6. Save book content to separate bookContent collection (if provided)
                if (content) {
                    const bookContentDoc = {
                        bookId: result.insertedId.toString(),
                        content: content,
                        createdAt: new Date(),
                        updatedAt: new Date()
                    };
                    await bookContentCollection.insertOne(bookContentDoc);
                }

                res.status(201).send({
                    success: true,
                    insertedId: result.insertedId,
                    book: newBookDoc
                });

            } catch (error) {
                console.error("Stripe Automate Error:", error);
                res.status(500).send({ success: false, error: error.message });
            }
        })

        // Get own ebooks (Manage Ebooks list)
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

        // ADMIN OR OWN WRITER
        // Update Ebook (Edit Ebook data or visibility status)
        app.patch('/api/books/:bookId', verifyToken, async (req, res) => {
            console.log('Received update request for bookId:', req.params.bookId, 'with updates:', req.body);
            try {
                const bookId = req.params.bookId;
                const writerId = req.user.id;
                const updates = req.body;
                // console.log("Received update request for bookId:", bookId, "with updates:", updates);
                // Strip out restricted fields to prevent tampering
                delete updates._id;
                delete updates.writerId;
                delete updates.writerEmail;

                // If content is present in updates, move it to bookContent collection and remove from updates
                const contentUpdate = updates.content;
                if (typeof contentUpdate !== 'undefined') {
                    delete updates.content; // remove from book metadata
                }

                if (req.user.role === 'admin') {
                    const filter = { _id: new ObjectId(bookId) };
                    const updateDoc = { $set: { ...updates, updatedAt: new Date() } };

                    const result = await bookCollection.updateOne(filter, updateDoc);

                    if (result.matchedCount === 0) {
                        return res.status(404).send({ error: true, message: "Book did not update." });
                    }

                    res.send({ success: true, message: "Book updated successfully", result });
                }
                else if (req.user.role === 'writer') {
                    // Ensure the book belongs to the requesting writer
                    const filter = { _id: new ObjectId(bookId), writerId: writerId };
                    const updateDoc = { $set: { ...updates, updatedAt: new Date() } };

                    const result = await bookCollection.updateOne(filter, updateDoc);

                    if (result.matchedCount === 0) {
                        return res.status(404).send({ error: true, message: "Book not found or unauthorized" });
                    }

                    // Update or insert book content
                    if (typeof contentUpdate !== 'undefined') {
                        await bookContentCollection.updateOne(
                            { bookId: bookId },
                            { $set: { content: contentUpdate, updatedAt: new Date(), bookId: bookId } },
                            { upsert: true }
                        );
                    }

                    res.send({ success: true, message: "Book updated successfully", result });
                }

            } catch (error) {
                console.error("Error updating book:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });

        // Delete Ebook
        app.delete('/api/writer/books/:bookId', verifyToken, verifyWriter, async (req, res) => {
            try {
                const bookId = req.params.bookId;
                const writerId = req.user.id;

                const filter = { _id: new ObjectId(bookId), writerId: writerId };
                const result = await bookCollection.deleteOne(filter);

                if (result.deletedCount === 0) {
                    return res.status(404).send({ error: true, message: "Book not found or unauthorized" });
                }

                // Remove book content from bookContent collection as well
                try {
                    await bookContentCollection.deleteOne({ bookId: bookId });
                } catch (err) {
                    console.error('Failed to delete book content for bookId:', bookId, err);
                }

                res.send({ success: true, message: "Book deleted successfully", result });
            } catch (error) {
                console.error("Error deleting book:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });

        // Get Writer Sales History
        app.get('/api/writer/sales-history', verifyToken, verifyWriter, async (req, res) => {

            console.log('Received request for sales history from writer:', req.user.id);
            try {
                const writerId = req.user.id;

                console.log('Fetching sales history for writer:', writerId);
                // Query transaction collection by writerId
                const transactions = await transactionCollection
                    .find({ writerId: writerId, type: 'purchase' })
                    .sort({ purchasedAt: -1 })
                    .toArray();

                res.send(transactions);
            } catch (error) {
                console.error("Error fetching sales history:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });

        // Check if reader purchased a book [protected]
        app.get('/api/reader/purchased-check/:bookId', verifyToken, verifyReader, async (req, res) => {
            try {
                const userId = req.user.id;
                const bookId = req.params.bookId;

                const purchase = await transactionCollection.findOne({
                    userId: userId,
                    bookId: bookId,
                    type: 'purchase'
                });

                res.send({ isPurchased: !!purchase });
            } catch (error) {
                console.error("Error checking purchase:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });

        // Get book content [protected, reader only - after purchase]
        app.get('/api/books/:bookId/content', verifyToken, async (req, res) => {

            try {
                const userId = req.user.id;
                const bookId = req.params.bookId;

                // Check if user purchased the book
                const purchase = await transactionCollection.findOne({
                    userId: userId,
                    bookId: bookId,
                    type: 'purchase'
                });
                if (req.user.role === 'reader' && !purchase) {
                    return res.status(403).send({ error: true, message: "You must purchase this book to access its content" });
                }

                const book = await bookCollection.findOne({ _id: new ObjectId(bookId) });
                if (req.user.role === 'writer' && req.user.id !== book?.writerId) {
                    return res.status(403).send({ error: true, message: "You are not the owner of this book content" });
                }
                // Get book content
                const bookContent = await bookContentCollection.findOne({
                    bookId: bookId
                });

                if (!bookContent) {
                    return res.status(404).send({ error: true, message: "Book content not found" });
                }
                res.send(bookContent);
            } catch (error) {
                console.error("Error fetching book content:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });

        // Update book content [protected, writer only]
        app.post('/api/books/:bookId/content', verifyToken, verifyWriter, async (req, res) => {
            try {
                const bookId = req.params.bookId;
                const writerId = req.user.id;
                const { content } = req.body;

                // Verify book belongs to writer
                const book = await bookCollection.findOne({
                    _id: new ObjectId(bookId),
                    writerId: writerId
                });

                if (!book) {
                    return res.status(403).send({ error: true, message: "Unauthorized" });
                }

                // Update or insert book content
                const result = await bookContentCollection.updateOne(
                    { bookId: bookId },
                    {
                        $set: {
                            bookId: bookId,
                            content: content,
                            updatedAt: new Date()
                        }
                    },
                    { upsert: true }
                );

                res.send({ success: true, result });
            } catch (error) {
                console.error("Error updating book content:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });


        // READER / PUBLIC WISHLIST ENDPOINTS
        // _____________________________________________________________________

        // WISHLIST - PROTECTED, Get logged-in user's wishlist details (Gallery mapping)
        app.get('/api/wishlist', verifyToken, async (req, res) => {
            try {
                const userId = req.user.id;

                // Find user and get wishlist array
                const user = await userCollection.findOne({
                    _id: new ObjectId(userId)
                });

                if (!user || !user.wishlist || user.wishlist.length === 0) {
                    return res.send([]);
                }

                // Convert wishlist IDs to ObjectIds and fetch full book details
                const wishlistBookIds = user.wishlist.map(id => new ObjectId(id));
                const wishlistBooks = await bookCollection.find({
                    _id: { $in: wishlistBookIds }
                }).toArray();

                res.send(wishlistBooks);
            } catch (error) {
                console.error("Error fetching wishlist:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });

        // Check if a book is in user's wishlist
        app.get('/api/wishlist/check/:bookId', verifyToken, async (req, res) => {
            try {
                const userId = req.user.id;
                const { bookId } = req.params;

                const user = await userCollection.findOne({
                    _id: new ObjectId(userId)
                });

                const isWishlisted = user?.wishlist?.includes(bookId) || false;

                res.send({
                    isWishlisted
                });
            } catch (error) {
                console.error("Error checking wishlist:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });

        // Add book to wishlist
        app.post('/api/wishlist', verifyToken, async (req, res) => {
            try {
                const userId = req.user.id;
                const { bookId } = req.body;

                if (!bookId) {
                    return res.status(400).send({ error: true, message: 'bookId is required' });
                }

                const user = await userCollection.findOne({
                    _id: new ObjectId(userId)
                });

                if (user?.wishlist?.includes(bookId)) {
                    return res.status(400).send({ error: true, message: 'Book already in wishlist' });
                }

                // Add bookId to wishlist array if it doesn't exist
                const result = await userCollection.updateOne(
                    { _id: new ObjectId(userId) },
                    { $push: { wishlist: bookId } }
                );

                if (result.modifiedCount === 0) {
                    return res.status(404).send({ error: true, message: 'User not found' });
                }

                res.status(201).send({
                    message: 'Book added to wishlist successfully'
                });
            } catch (error) {
                console.error("Error adding to wishlist:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });

        // Remove book from wishlist
        app.delete('/api/wishlist/:bookId', verifyToken, async (req, res) => {
            try {
                const userId = req.user.id;
                const { bookId } = req.params;

                const result = await userCollection.updateOne(
                    { _id: new ObjectId(userId) },
                    { $pull: { wishlist: bookId } }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({ error: true, message: 'User not found' });
                }

                res.send({ message: 'Book removed from wishlist successfully' });
            } catch (error) {
                console.error("Error removing from wishlist:", error);
                res.status(500).send({ error: true, message: error.message });
            }
        });






        // READER PUBLIC ENDPOINT____________________________________________________________
        app.post('/api/checkout/create-session', verifyToken, verifyReader, async (req, res) => {
            // console.log('Received checkout session request with body:', req.body);
            try {
                const { bookId } = req.body;

                // Pull the book target document straight from MongoDB
                const book = await bookCollection.findOne({ _id: new ObjectId(bookId) });

                if (!book || !book.stripePriceId) {
                    // console.log("Book not found or missing Stripe price association:", book);
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
                        userId: req.user.id,
                        userName: req.user.name,
                        userEmail: req.user.email,
                        bookId: book._id.toString(),
                        bookTitle: book.title,
                        writerId: book.writerId.toString(),
                        // amountPaid: book.title,
                    },
                    success_url: `${process.env.CLIENT_URL}/books/${bookId}?status=success`,
                    cancel_url: `${process.env.CLIENT_URL}/books/${bookId}?status=cancelled`,
                });
                // console.log("Stripe checkout session metadata 1:", session.metadata);
                // console.log("Checkout session created:", session.url);
                res.send({ url: session.url });
            } catch (error) {
                console.error("Error creating checkout session:", error);
                res.status(500).send({ error: error.message });
            }
        });

        // app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
        //     console.log('=== WEBHOOK RECEIVED ===');
        //     console.log('Received Stripe webhook event');
        //     const sig = req.headers['stripe-signature'];
        //     console.log('Signature present:', !!sig);
        //     console.log('Webhook secret configured:', !!process.env.STRIPE_WEBHOOK_SECRET);
        //     let event;

        //     try {
        //         // Verify that the request actually came from Stripe
        //         console.log('Attempting to construct event...');
        //         event = stripe.webhooks.constructEvent(
        //             req.body,
        //             sig,
        //             process.env.STRIPE_WEBHOOK_SECRET // Get this from Stripe CLI or Dashboard
        //         );
        //         console.log('✓ Event verified successfully');
        //     } catch (err) {
        //         console.error(`✗ Webhook Signature Verification Failed:`, err.message);
        //         return res.status(400).send(`Webhook Error: ${err.message}`);
        //     }

        //     console.log('Event type:', event.type);
        //     console.log('Event session/object id:', event.data.object.id);

        //     // Handle the specific successful payment event
        //     if (event.type === 'checkout.session.completed') {
        //         console.log('✓ Processing checkout.session.completed event');
        //         const session = event.data.object;

        //         // Extract the variables we stashed in metadata earlier
        //         const { userId, buyerName, buyerEmail, bookTitle, bookId } = session.metadata;
        //         console.log('Metadata:', { userId, buyerName, buyerEmail, bookTitle, bookId });
        //         const amountPaid = session.amount_total / 100; // Stripe provides this in cents (e.g., 1000 = $10.00)

        //         try {
        //             const newTransaction = {
        //                 buyerName: buyerName,
        //                 bookTitle: bookTitle,
        //                 type: 'purchase',
        //                 bookId: bookId,

        //                 buyerEmail: buyerEmail,
        //                 amount: amountPaid,
        //                 paymentDate: new Date(),
        //                 buyerId: userId,
        //                 stripeSessionId: session.id,
        //             };
        //             console.log('Attempting to save transaction:', newTransaction);

        //             const result = await transactionCollection.insertOne(newTransaction);
        //             console.log(`✓ Transaction saved successfully for Book ID: ${bookId}, Tx ID: ${result.insertedId}`);

        //             // OPTIONAL: Update user collection here to give them instant library access
        //             // await userCollection.updateOne({ _id: new ObjectId(userId) }, { $push: { purchasedBooks: bookId } });

        //         } catch (dbError) {
        //             console.error("✗ Failed to insert transaction into DB:", dbError);
        //             // Return a 500 so Stripe knows your server failed and will retry sending the event
        //             return res.status(500).send("Database insertion failed");
        //         }
        //     } else {
        //         console.log(`Webhook event type '${event.type}' - no action needed`);
        //     }

        //     // Return a 200 response to Stripe to acknowledge receipt of the event
        //     console.log('=== WEBHOOK COMPLETE ===\n');
        //     res.json({ received: true });
        // });



        // test user preference [private]
        app.patch('/api/user/preference', verifyToken, async (req, res) => {


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


        // Get reader dashboard data
        app.get('/api/reader/dashboard', verifyToken, verifyReader, async (req, res) => {
            try {
                const userId = req.user.id;

                // Get total books purchased
                const totalBooks = await transactionCollection.countDocuments({ userId, type: 'purchase' });

                // Get total spent
                const transactions = await transactionCollection.find({ userId, type: 'purchase' }).toArray();
                const totalSpent = transactions.reduce((sum, t) => sum + (t.amountPaid || 0), 0);

                // Get wishlist count
                const user = await userCollection.findOne({ _id: new ObjectId(userId) });
                const wishlistCount = user?.wishlist?.length || 0;

                res.send({
                    totalBooks,
                    totalSpent: totalSpent.toFixed(2),
                    wishlistCount,
                    recentBooks: transactions.slice(0, 5)
                });
            } catch (error) {
                console.error('Error fetching reader dashboard:', error);
                res.status(500).json({ message: 'Failed to fetch reader dashboard' });
            }
        });

        // Get writer dashboard data
        app.get('/api/writer/dashboard', verifyToken, verifyWriter, async (req, res) => {
            try {
                const writerId = req.user.id;

                // Get total books published
                const totalBooks = await bookCollection.countDocuments({ writerId });
                const publishedBooks = await bookCollection.countDocuments({ writerId, visibility: 'publish' });

                // Calculate average price of the writer's books
                const books = await bookCollection.find({ writerId }).toArray();
                const totalBooksPrice = books.reduce((sum, b) => sum + (b.price || 0), 0);
                const avgPrice = books.length > 0 ? (totalBooksPrice / books.length) : 0;

                // Get total sales from transactions
                const sales = await transactionCollection.find({ writerId, type: 'purchase' }).toArray();
                const totalSales = sales.length;
                const totalRevenue = sales.reduce((sum, t) => sum + (t.amountPaid || 0), 0);

                res.send({
                    totalBooks,
                    publishedBooks,
                    totalSales,
                    totalRevenue: totalRevenue.toFixed(2),
                    avgPrice: avgPrice.toFixed(2),
                    recentSales: sales.slice(0, 5)
                });
            } catch (error) {
                console.error('Error fetching writer dashboard:', error);
                res.status(500).json({ message: 'Failed to fetch writer dashboard' });
            }
        });


        // Get purchase history for reader
        app.get('/api/reader/purchase-history', verifyToken, verifyReader, async (req, res) => {
            try {
                const userId = req.user.id;
                const purchases = await transactionCollection
                    .find({ userId: userId, type: 'purchase' })
                    .sort({ purchasedAt: -1 })
                    .toArray();

                // Fetch book details for each purchase
                const enrichedPurchases = await Promise.all(
                    purchases.map(async (purchase) => {
                        // delete purchase._id; // Remove MongoDB _id to avoid confusion
                        delete purchase.stripeSessionId;
                        delete purchase.paymentIntentId;

                        const book = await bookCollection.findOne({ _id: new ObjectId(purchase.bookId) });
                        return {
                            ...purchase,
                            // title: book?.title || purchase.bookTitle,
                            writerName: book?.writerName,
                            // price: book?.price || purchase.amountPaid,
                            visibility: book?.visibility,
                            image: book?.image
                        };
                    })
                );

                res.send(enrichedPurchases);
            } catch (error) {
                console.error('Error fetching purchase history:', error);
                res.status(500).json({ message: 'Failed to fetch purchase history' });
            }
        });

        // Get purchased books for reader
        app.get('/api/reader/purchased-books', verifyToken, verifyReader, async (req, res) => {
            try {
                const userId = req.user.id;
                const purchases = await transactionCollection
                    .find({ userId: userId, type: 'purchase' })
                    .toArray();

                const bookIds = purchases.map(p => new ObjectId(p.bookId));
                const books = await bookCollection
                    .find({ _id: { $in: bookIds } })
                    .toArray();

                res.send(books);
            } catch (error) {
                console.error('Error fetching purchased books:', error);
                res.status(500).json({ message: 'Failed to fetch purchased books' });
            }
        });

        // Get reader's wishlist (already exists, but ensuring it's here)
        app.get('/api/reader/wishlist', verifyToken, verifyReader, async (req, res) => {
            try {
                const userId = req.user.id;
                const result = await wishlistCollection
                    .aggregate([
                        { $match: { userId: new ObjectId(userId) } },
                        {
                            $lookup: {
                                from: 'book',
                                localField: 'bookId',
                                foreignField: '_id',
                                as: 'bookDetails'
                            }
                        },
                        { $unwind: '$bookDetails' },
                        {
                            $project: {
                                _id: '$bookDetails._id',
                                title: '$bookDetails.title',
                                author: '$bookDetails.author',
                                price: '$bookDetails.price',
                                coverImage: '$bookDetails.coverImage',
                                isPublished: '$bookDetails.isPublished'
                            }
                        }
                    ])
                    .toArray();

                res.send(result);
            } catch (error) {
                console.error('Error fetching wishlist:', error);
                res.status(500).json({ message: 'Failed to fetch wishlist' });
            }
        });

        // Get reader profile
        app.get('/api/reader/profile', verifyToken, verifyReader, async (req, res) => {
            try {
                const userId = req.user.id;
                const user = await userCollection.findOne({ _id: new ObjectId(userId) });

                if (!user) {
                    return res.status(404).json({ message: 'User not found' });
                }

                res.send({
                    _id: user._id,
                    name: user.name,
                    email: user.email,
                    image: user.image,
                    bio: user.bio
                });
            } catch (error) {
                console.error('Error fetching profile:', error);
                res.status(500).json({ message: 'Failed to fetch profile' });
            }
        });

        // Update reader profile
        app.patch('/api/reader/profile', verifyToken, verifyReader, async (req, res) => {
            try {
                const userId = req.user.id;
                const updateData = req.body;

                // Only allow these fields to be updated
                const allowedFields = { name: 1, bio: 1, image: 1 };
                const filteredData = {};
                Object.keys(updateData).forEach(key => {
                    if (allowedFields[key]) {
                        filteredData[key] = updateData[key];
                    }
                });

                const result = await userCollection.updateOne(
                    { _id: new ObjectId(userId) },
                    { $set: filteredData }
                );

                res.send(result);
            } catch (error) {
                console.error('Error updating profile:', error);
                res.status(500).json({ message: 'Failed to update profile' });
            }
        });


        // ==================== ADMIN ENDPOINTS ====================

        // Get all users (admin)
        app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const users = await userCollection
                    .find({})
                    .project({ password: 0 })
                    .toArray();

                res.send(users);
            } catch (error) {
                console.error('Error fetching users:', error);
                res.status(500).json({ message: 'Failed to fetch users' });
            }
        });

        // Update user role (admin)
        app.patch('/api/admin/users/:userId/role', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const { userId } = req.params;
                const { role } = req.body;

                if (!['reader', 'writer', 'admin'].includes(role)) {
                    return res.status(400).json({ message: 'Invalid role' });
                }

                const result = await userCollection.updateOne(
                    { _id: new ObjectId(userId) },
                    { $set: { role } }
                );

                res.send(result);
            } catch (error) {
                console.error('Error updating user role:', error);
                res.status(500).json({ message: 'Failed to update user role' });
            }
        });

        // Delete user (admin)
        app.delete('/api/admin/users/:userId', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const { userId } = req.params;

                const result = await userCollection.deleteOne(
                    { _id: new ObjectId(userId) }
                );

                res.send(result);
            } catch (error) {
                console.error('Error deleting user:', error);
                res.status(500).json({ message: 'Failed to delete user' });
            }
        });

        // Get all books (admin)
        app.get('/api/admin/books', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const books = await bookCollection
                    .find({})
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(books);
            } catch (error) {
                console.error('Error fetching books:', error);
                res.status(500).json({ message: 'Failed to fetch books' });
            }
        });

        // Update book status (admin)
        app.patch('/api/admin/books/:bookId/status', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const { bookId } = req.params;
                const { visibility } = req.body;

                const result = await bookCollection.updateOne(
                    { _id: new ObjectId(bookId) },
                    { $set: { visibility } }
                );

                res.send(result);
            } catch (error) {
                console.error('Error updating book status:', error);
                res.status(500).json({ message: 'Failed to update book status' });
            }
        });

        // Delete book (admin)
        app.delete('/api/admin/books/:bookId', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const { bookId } = req.params;

                const result = await bookCollection.deleteOne(
                    { _id: new ObjectId(bookId) }
                );

                res.send(result);
            } catch (error) {
                console.error('Error deleting book:', error);
                res.status(500).json({ message: 'Failed to delete book' });
            }
        });

        // Get all transactions (admin)
        app.get('/api/admin/transactions', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const transactions = await transactionCollection
                    .find({})
                    .sort({ purchasedAt: -1 })
                    .toArray();

                res.send(transactions);
            } catch (error) {
                console.error('Error fetching transactions:', error);
                res.status(500).json({ message: 'Failed to fetch transactions' });
            }
        });

        // Get dashboard analytics (admin)
        app.get('/api/admin/analytics', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const totalUsers = await userCollection.countDocuments({ role: 'reader' });
                const totalWriters = await userCollection.countDocuments({ role: 'writer' });

                const sales = await transactionCollection
                    .find({ type: 'purchase' })
                    .toArray();

                const totalBooksSold = sales.length;
                const totalRevenue = sales.reduce((sum, t) => sum + (t.amountPaid || 0), 0);

                res.send({
                    totalUsers,
                    totalWriters,
                    totalBooksSold,
                    totalRevenue
                });
            } catch (error) {
                console.error('Error fetching analytics:', error);
                res.status(500).json({ message: 'Failed to fetch analytics' });
            }
        });

        // Get monthly sales data (admin)
        app.get('/api/admin/analytics/monthly-sales', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const sales = await transactionCollection
                    .aggregate([
                        { $match: { type: 'purchase' } },
                        {
                            $group: {
                                _id: {
                                    year: { $year: '$purchasedAt' },
                                    month: { $month: '$purchasedAt' }
                                },
                                sales: { $sum: '$amountPaid' }
                            }
                        },
                        { $sort: { '_id.year': -1, '_id.month': -1 } }
                    ])
                    .toArray();

                const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                const formattedSales = sales.map(item => ({
                    month: `${monthNames[item._id.month - 1]} ${item._id.year}`,
                    sales: item.sales
                }));

                res.send(formattedSales);
            } catch (error) {
                console.error('Error fetching monthly sales:', error);
                res.status(500).json({ message: 'Failed to fetch monthly sales' });
            }
        })

        // Get books by genre (admin)
        app.get('/api/admin/analytics/books-by-genre', verifyToken, verifyAdmin, async (req, res) => {
            try {
                // books have `genres` as an array. unwind and count each genre occurrence.
                const booksByGenre = await bookCollection
                    .aggregate([
                        // ensure there is at least one genre; replace empty/null with ['Unknown']
                        {
                            $addFields: {
                                genresArr: {
                                    $cond: [
                                        { $gt: [{ $size: { $ifNull: ['$genres', []] } }, 0] },
                                        '$genres',
                                        ['Unknown']
                                    ]
                                }
                            }
                        },
                        { $unwind: '$genresArr' },
                        {
                            $group: {
                                _id: '$genresArr',
                                count: { $sum: 1 }
                            }
                        },
                        { $sort: { count: -1 } }
                    ])
                    .toArray();

                const formattedGenres = booksByGenre.map(item => ({
                    genre: item._id || 'Unknown',
                    count: item.count
                }));

                res.send(formattedGenres);
            } catch (error) {
                console.error('Error fetching books by genre:', error);
                res.status(500).json({ message: 'Failed to fetch books by genre' });
            }
        });

        // app.get('/protected-message', verifyToken, async (req, res) => {
        //     // res.send(result);
        //     res.json({ message: 'protected messaged accessed' });


        // });

        app.get('/api/user/:userId', verifyToken, async (req, res) => {
            try {
                const { userId } = req.params;
                const user = await userCollection.findOne({ _id: new ObjectId(userId) }, { projection: { password: 0 } });
                if (!user) {
                    return res.status(404).json({ message: 'User not found' });
                }
                res.json(user);
            } catch (error) {
                console.error('Error fetching user:', error);
                res.status(500).json({ message: 'Failed to fetch user' });
            }
        });

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





















