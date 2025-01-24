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

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const handleRateLimit = async (error) => {
    if (error.extensions && error.extensions.code === 'THROTTLED') {
        const retryAfter = parseInt(error.extensions.retryAfter) || 5000; 
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
            fs.createReadStream(process.env.UPDATE_COSTS),
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
const updateInventoryMutation = `
    mutation inventoryItemUpdate($id: ID!, $input: InventoryItemUpdateInput!) {
        inventoryItemUpdate(id: $id, input: $input) {
            inventoryItem {
                id
                unitCost {
                    amount
                }
            }
            userErrors {
                field
                message
            }
        }
    }
`;


const updateUnitCost = async(sku, newCost) => {
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
                        }
                    }
                }
            }
        }
        `;

        const response = await shopify.graphql(query);
        
        if (response) {
            let currCost = parseFloat(response.productVariants.edges[0].node.inventoryItem.unitCost.amount)
            newCost = parseFloat(newCost)

            if (currCost != newCost) {

                const inventoryItemId = response.productVariants.edges[0].node.inventoryItem.id;

                const costVariables = {
                    id: inventoryItemId,
                    input: {
                        cost: newCost
                    }
                };

                const costUpdateResponse = await shopify.graphql(updateInventoryMutation, costVariables);
                if (costUpdateResponse.inventoryItemUpdate.userErrors.length > 0) {
                    console.log(`User Errors:`, costUpdateResponse.inventoryItemUpdate.userErrors);
                } else {
                    console.log(`Updated Inventory Item for SKU ${sku} with new cost:`, costUpdateResponse.inventoryItemUpdate.inventoryItem);
                }
            }
        } else {
            console.log(`No product found for SKU ${sku}`);
        }

    } catch (error) {
        if (error.extensions && error.extensions.code === 'THROTTLED') {
            await handleRateLimit(error);
            return updateUnitCost(sku, newCost); // Retry after waiting
        } else {
            console.error(`Error updating SKU ${sku}:`, error);
        }
    }
};


async function updateInventoryFromFetchedCSV() {
    const products = await fetch_csv_products();

    for (const product of products) { // Using for...of for async/await compatibility
        const sku = product["SKU"];
        const unitCost = product['Unit Cost_supplier'];

        if (sku && !isNaN(unitCost)) {
            await updateUnitCost(sku, unitCost); // Awaiting the async function
        }
    }
}

updateInventoryFromFetchedCSV().catch(error => {
    console.error("An error occurred while updating inventory:", error);
});

