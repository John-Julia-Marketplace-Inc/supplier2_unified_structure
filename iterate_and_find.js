const axios = require('axios');
const csv = require('csv-parser');
const Shopify = require('shopify-api-node');
// require('dotenv').config();
const stream = require('stream');
const { promisify } = require('util');
const fs = require('fs');

const pipeline = promisify(stream.pipeline);

const shopify = new Shopify({
    shopName: process.env.SHOP,
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const handleRateLimit = async (error) => {
    if (error.extensions && error.extensions.code === 'THROTTLED') {
        const retryAfter = parseInt(error.extensions.retryAfter) || 4000; // Default wait time of 2 seconds if no retryAfter is provided
        console.log(`Rate limited! Waiting for ${retryAfter} ms before retrying...`);
        await wait(retryAfter); // Wait for the time suggested by Shopify (or 2 seconds)
    } else {
        throw error;
    }
};

async function fetch_csv_products() {
    const products = [];
    try {
        await pipeline(
            fs.createReadStream(process.env.ITERATE_AND_FIND),
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

const getResults = async (sku) => {
    try {
        const query = `
        {
            productVariants(first: 100, query: "sku:${sku}") {
                edges {
                    node {
                        id
                        title
                        sku
                        product {
                            title
                            id
                            handle
                        }
                        price
                        barcode
                        inventoryItem {
                            id
                            unitCost {
                                amount
                                currencyCode
                            }
                            inventoryLevels(first: 10) {
                                edges {
                                    node {
                                        id
                                        quantities(names: "available") {
                                            quantity
                                            name
                                        }
                                        location {
                                            id
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

        const response = await shopify.graphql(query);

        if (response && response.productVariants && response.productVariants.edges.length > 0) {
            const variants = response.productVariants.edges;

            const unitCost = parseFloat(variants[0].node.inventoryItem.unitCost.amount);

            const sizes = [];
            const quantities = [];

            for (const edge of variants) {
                let variant = edge.node;
                let inventoryLevels = variant.inventoryItem.inventoryLevels.edges;

                sizes.push(variant.title); // Add size
                quantities.push(inventoryLevels[0].node.quantities[0].quantity); // Add quantity
            }

            return { sizes, quantities, unitCost };
        } else {
            console.log(`No product found for SKU ${sku}`);
            return null;
        }
    } catch (error) {
        if (error.extensions && error.extensions.code === 'THROTTLED') {
            await handleRateLimit(error);
            return getResults(sku); // Retry after waiting
        } else {
            console.error(`Error fetching details for SKU ${sku}:`, error);
        }
    }
};

async function updateInventoryFromFetchedCSV() {
    console.time("Total Execution Time"); // Start the timer
    const products = await fetch_csv_products();
    const outputFile = fs.createWriteStream(`${process.env.FOLDER}/shopify_data.csv`);
    const toAddFile = fs.createWriteStream(`${process.env.FOLDER}/to_add.csv`)

    // Write the header
    outputFile.write('SKU,Sizes,Quantities,Unit Cost\n');
    toAddFile.write('SKU\n');

    for (const product of products) {
        const sku = product["SKU"];

        if (sku) {
            let result = await getResults(sku);

            if (result) {
                let sizes = result.sizes.join(';'); 
                let quantities = result.quantities.join(';'); 
                let cost = result.unitCost;

                // Write to file
                outputFile.write(`${sku},${sizes},${quantities},${cost}\n`);
            } else {
                toAddFile.write(`${sku}\n`);
            }
        }
    }

    outputFile.end();
    console.timeEnd("Total Execution Time"); // End the timer
}

updateInventoryFromFetchedCSV();
