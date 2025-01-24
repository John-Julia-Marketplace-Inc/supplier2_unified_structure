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
        const retryAfter = parseInt(error.extensions.retryAfter) || 2000; // Default wait time of 2 seconds if no retryAfter is provided
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
            fs.createReadStream('data/os_update.csv'),
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

            console.log(`Current Cost: ${currCost}, New Cost: ${newCost}`)

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

// Function to update inventory quantity and cost for a given SKU
const updateInventoryQuantity = async (sku, size, newQuantity) => {
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

            for (const edge of variants) {
                let variant = edge.node;
                let inventoryItemId = variant.inventoryItem.id;
                let inventoryLevels = variant.inventoryItem.inventoryLevels.edges;
                let locationId = inventoryLevels[0].node.location.id;

                let currSize = variant.title
                
                if (currSize === size) {
                    const availableDelta = newQuantity - inventoryLevels[0].node.quantities[0].quantity

                    if (availableDelta == 0 || availableDelta == '0') { 
                            console.log(`No update needed for ${sku}`)
                            return
                    }

                    const mutation = `
                        mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
                            inventoryAdjustQuantities(input: $input) {
                                userErrors {
                                    field
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
                        "input": {
                        "reason": "correction",
                        "name": "available",
                        "changes": [
                            {
                            "delta": availableDelta,
                            "inventoryItemId": inventoryItemId,
                            "locationId": locationId
                            }
                        ]
                        }
                    }
                    

                    const updateResponse = await shopify.graphql(mutation, variables);
                    console.log(`Updated SKU ${sku} to quantity ${newQuantity}:`, updateResponse);

                }
            }
        } else {
            console.log(`No product found for SKU ${sku}`);
        }

    } catch (error) {
        if (error.extensions && error.extensions.code === 'THROTTLED') {
            await handleRateLimit(error);
            return updateInventoryQuantity(sku, size, newQuantity); // Retry after waiting
        } else {
            console.error(`Error updating SKU ${sku}:`, error);
        }
    }
};


async function updateInventoryFromFetchedCSV() {
    const products = await fetch_csv_products();

    for (const product of products) {
        const sku = product["SKU"];
        const sizes = product["Size"];
        const quantities = product["Qty_supplier"];

        await updateInventoryQuantity(sku, sizes, quantities);
        
    }

    console.log('Inventory update complete.');
}

updateInventoryFromFetchedCSV()