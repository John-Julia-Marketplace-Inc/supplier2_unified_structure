const axios = require('axios');
const csv = require('csv-parser');
const Shopify = require('shopify-api-node');
require('dotenv').config();
const stream = require('stream');
const { promisify } = require('util');
const fs = require('fs');

const pipeline = promisify(stream.pipeline);

const shopify = new Shopify({
    shopName: process.env.SHOP,
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const handleRateLimit = async (error) => {
    if (error.extensions && error.extensions.code === 'THROTTLED') {
        const retryAfter = parseInt(error.extensions.retryAfter) || 5000;
        console.log(`Rate limited! Waiting for ${retryAfter} ms before retrying...`);
        await wait(retryAfter);
    } else {
        throw error;
    }
};

async function fetch_csv_products() {
    const products = [];
    try {
        await pipeline(
            fs.createReadStream(process.env.ZERO_INVENTORY),
            csv(),
            new stream.Writable({
                objectMode: true,
                write(product, encoding, callback) {
                    products.push(product);
                    callback();
                },
            })
        );
    } catch (error) {
        console.log(`Error fetching products: ${error}`);
    }
    return products;
}

const setInventoryZero = async (sku) => {
    try {
        const query = `
        {
            productVariants(first: 100, query: "sku:${sku}") {
                edges {
                    node {
                        inventoryItem {
                            id
                            inventoryLevels(first: 10) {
                                edges {
                                    node {
                                        id
                                        location {
                                            id
                                        }
                                        quantities(names: "available") {
                                            quantity
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

        if (response?.productVariants?.edges.length > 0) {
            const variant = response.productVariants.edges[0].node;
            const inventoryItemId = variant.inventoryItem.id;
            const inventoryLevel = variant.inventoryItem.inventoryLevels.edges[0].node;
            const inventoryLevelId = inventoryLevel.id;
            const locationId = inventoryLevel.location.id;
            const currentQuantity = parseInt(inventoryLevel.quantities[0].quantity, 10);

            if (currentQuantity === 0) {
                // console.log(`SKU ${sku} already has quantity 0.`);
                return 'no_action';
            }

            const delta = -currentQuantity;
            if (delta > 0) {
                console.log(`Error updating SKU ${sku}: invalid delta.`);
                return 'delta_issue';
            }

            const mutation = `
            mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
                inventoryAdjustQuantities(input: $input) {
                    userErrors { 
                        message
                    }
                    inventoryAdjustmentGroup {
                        createdAt
                        reason
                        changes {
                            name
                            delta
                        }
                    }
                }
            }
            `;

            const variables = {
                input: {
                    reason: "correction",
                    name: "available",
                    changes: [
                        {
                            delta: delta,
                            inventoryItemId: inventoryItemId,
                            locationId: locationId,
                        },
                    ],
                },
            };

            const updateResponse = await shopify.graphql(mutation, variables);

            if (updateResponse?.inventoryAdjustQuantities?.userErrors?.length > 0) {
                console.log(`Error updating SKU ${sku}:`, updateResponse.inventoryAdjustQuantities.userErrors);
                return 'error';
            }

            // console.log(`Successfully set SKU ${sku} quantity to 0.`);
            return 'success';
        } else {
            console.log(`No product found for SKU ${sku}.`);
            return 'not_found';
        }
    } catch (error) {
        if (error.extensions && error.extensions.code === 'THROTTLED') {
            await handleRateLimit(error);
            return setInventoryZero(sku); // Retry after waiting
        } else {
            console.error(`Error updating SKU ${sku}:`, error);
            return 'error';
        }
    }
};

async function updateInventoryFromFetchedCSV() {
    const products = await fetch_csv_products();

    for (const product of products) {
        const sku = product["SKU"];
        if (sku) {
            await setInventoryZero(sku); // Await each SKU update
        }
    }

    console.log('Inventory update complete.');
}

updateInventoryFromFetchedCSV().catch((error) => {
    console.error("An error occurred during the inventory update process:", error);
});
