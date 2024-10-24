const axios = require('axios');
const csv = require('csv-parser');
const Shopify = require('shopify-api-node');
const stream = require('stream');
const { promisify } = require('util');
const fs = require('fs');

const pipeline = promisify(stream.pipeline);

const OUTFILE = process.env.OUTFILE;
const INFILE  = process.env.INFILE;

console.log('INFILE:', INFILE);
console.log('OUTFILE:', OUTFILE);

const shopify = new Shopify({
    shopName: process.env.SHOP,
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
});

async function fetch_csv_products(link) {
    const products = [];
    try {
        await pipeline(
            fs.createReadStream(link),
            csv(),
            new stream.Writable({
                objectMode: true,
                write(product, encoding, callback) {
                    products.push(product);
                    callback();
                }
            })
        );
    } catch (error) {
        console.log(`Error fetching products: ${error}`);
    }
    return products;
}

const fetchProductBySku = async (sku) => {
    try {
        // First query for active products
        const activeQuery = `
        {
            productVariants(first: 100, query: "sku:${sku}") {
                edges {
                    node {
                        id
                        title
                        inventoryPolicy
                        sku
                        product {
                            title
                            id
                            handle
                            status
                        }
                        price
                        barcode
                        inventoryItem {
                            id
                            inventoryLevels(first: 10) {
                                edges {
                                    node {
                                        id
                                        available
                                        location {
                                            name
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        `;

        let response = await shopify.graphql(activeQuery);

        if (response.errors) {
            console.error('GraphQL Errors:', response.errors);
            return;
        } else if (response.productVariants.edges.length === 0) {
            // If no active product is found, check for drafts
            console.log(`Active SKU ${sku} not found. Checking drafts...`);
            const draftQuery = `
            {
                products(first: 1, query: "sku:${sku} AND status:draft") {
                    edges {
                        node {
                            id
                            title
                            handle
                            status
                            variants(first: 100) {
                                edges {
                                    node {
                                        id
                                        title
                                        sku
                                        inventoryPolicy
                                        price
                                        barcode
                                        inventoryItem {
                                            id
                                            inventoryLevels(first: 10) {
                                                edges {
                                                    node {
                                                        id
                                                        available
                                                        location {
                                                            name
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            `;
            response = await shopify.graphql(draftQuery);

            if (response.products.edges.length === 0) {
                console.log(`SKU ${sku} not found in drafts.`);
                return false;
            } else {
                return true;
            }
        } else {
            return true;
        }
    } catch (error) {
        console.error('Error fetching product by SKU:', error);
        return false;
    }
};

async function checkAllSkus(link) {
    const products = await fetch_csv_products(link);
    const existingSkus = []

    for (const product of products) {
        const sku = product['SKU']; 
        const exists = await fetchProductBySku(sku);
        if (!exists) {
            existingSkus.push(sku);
        }
    }

    console.log('Number of non-existing SKUs:', existingSkus.length);

    const csvStream = fs.createWriteStream(OUTFILE);
    csvStream.write('SKU\n'); 
    existingSkus.forEach(sku => {
        csvStream.write(`${sku}\n`); 
    });
    csvStream.end();
}

// Start the process
checkAllSkus(INFILE);