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
        const retryAfter = parseInt(error.extensions.retryAfter) || 2000; // Default wait time of 2 seconds if no retryAfter is provided
        console.log(`Rate limited! Waiting for ${retryAfter} ms before retrying...`);
        await wait(retryAfter); // Wait for the time suggested by Shopify (or 2 seconds)
    } else {
        throw error; // If it's not a rate-limiting error, rethrow it
    }
};

// Fetch CSV products from file
async function fetch_csv_products() {
    const products = [];
    console.log('Update file:', process.env.TO_UPDATE)
    try {
        await pipeline(
            fs.createReadStream(process.env.TO_UPDATE),
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

// GraphQL mutation for updating inventory item unit cost
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

// Function to update inventory quantity and cost for a given SKU and update unit cost for all variants
const updateInventoryAndCost = async (sku, newQuantity, size, newCost, updateUnitCost) => {
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
                            id
                            title
                            handle
                            variants(first: 100) {
                                edges {
                                    node {
                                        id
                                        inventoryItem {
                                            id
                                            unitCost {
                                                amount
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        inventoryItem {
                            id
                            inventoryLevels(first: 100) {
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

        const response = await shopify.graphql(query);

        if (response && response.productVariants && response.productVariants.edges.length > 0) {
            const variants = response.productVariants.edges;
            const product = variants[0].node.product;

            // Update quantity for the specific size
            for (const variantEdge of variants) {
                const variant = variantEdge.node;
                const sizeOption = variant.title;

                if (sizeOption == size) {
                    console.log('Found SKU:', sku);

                    const inventoryItemId = variant.inventoryItem.id;

                    const current_qty = variant.inventoryItem.inventoryLevels.edges[0].node.available;

                    const availableDelta = parseInt(newQuantity) - parseInt(current_qty);
                    
                    if (availableDelta == 0 || availableDelta == '0') { 
                        console.log(`No update needed for ${sku} size: ${size}`)
                        break;
                    }

                    const inventoryLevelId = variant.inventoryItem.inventoryLevels.edges[0].node.id;

                    if (inventoryLevelId) {
                        const mutation = `
                        mutation {
                            inventoryAdjustQuantity(input: {inventoryLevelId: "${inventoryLevelId}", availableDelta: ${availableDelta}}) {
                                inventoryLevel {
                                    id
                                    available
                                }
                            }
                        }
                        `;
                        await shopify.graphql(mutation);
                        console.log(`Updated inventory for SKU ${sku}, Size ${size} to ${newQuantity}.`);
                    } else {
                        console.log(`No inventory level found for SKU ${sku}, Size ${size}.`);
                    }
                    break;
                }
            }

            if (updateUnitCost) {
                // Update unit cost for all variants of the product
                for (const variantEdge of product.variants.edges) {
                    const inventoryItemId = variantEdge.node.inventoryItem.id;
                    const existingCost = parseFloat(variantEdge.node.inventoryItem.unitCost.amount);

                    // Using tolerance to compare floating-point numbers
                    if (Math.abs(existingCost - newCost) > 0.01) {
                        console.log(`Existing cost (${existingCost}) is different from new cost (${newCost}). Updating...`);

                        const costVariables = {
                            id: inventoryItemId,
                            input: {
                                cost: parseFloat(newCost)
                            }
                        };

                        const costUpdateResponse = await shopify.graphql(updateInventoryMutation, costVariables);
                        if (costUpdateResponse.inventoryItemUpdate.userErrors.length > 0) {
                            console.log(`User Errors:`, costUpdateResponse.inventoryItemUpdate.userErrors);
                        } else {
                            console.log(`Updated Inventory Item for SKU ${sku} with new cost:`, costUpdateResponse.inventoryItemUpdate.inventoryItem);
                        }
                    } else {
                        console.log(`Existing cost (${existingCost}) is the same as new cost (${newCost}). No update required.`);
                    }
                }
            }
        } else {
            console.log(`SKU ${sku} not found.`);
        }

    } catch (error) {
        if (error.extensions && error.extensions.code === 'THROTTLED') {
            await handleRateLimit(error);
            return updateInventoryAndCost(sku, newQuantity, size, newCost, updateUnitCost)
        } else {
            console.error(`Error updating SKU ${sku}:`, error);
        }
    }
    console.log('\n=========\n');
};


// Function to update inventory from fetched CSV products
async function updateInventoryFromFetchedCSV() {
    const products = await fetch_csv_products();

    for (let i = 0; i < products.length; i++) {
        const product = products[i];
        const skuFull = product["SKU"];
        const sizeField = product['Size'];  // "S,M"
        const quantityField = product["Qty"];  // "1,1"
        const unitCost = parseFloat(product['Unit Cost']).toFixed(2);  // "1663.2"

        if (!skuFull) {
            console.log('Missing SKU FULL in product:', product);
            continue;
        }

        if (!sizeField || !quantityField) {
            console.log('Missing size or quantity in product:', product);
            continue;
        }

        const sizes = sizeField.split(',');  // Split sizes into array ["S", "M"]
        const quantities = quantityField.split(',');  // Split quantities into array ["1", "1"]

        if (sizes.length !== quantities.length) {
            console.log(`Mismatch between sizes and quantities for SKU: ${skuFull}`);
            continue;
        }

        // Loop through each size and quantity
        for (let j = 0; j < sizes.length; j++) {
            const size = sizes[j];
            const quantity = parseInt(quantities[j]);

            if (!isNaN(quantity) && !isNaN(unitCost)) {
                console.log(`Processing SKU: ${skuFull}, Size: ${size}, Qty: ${quantity}, Unit Cost: ${unitCost}`);

                if (j == 0) {
                    await updateInventoryAndCost(skuFull, quantity, size, unitCost, true);
                } else {
                    await updateInventoryAndCost(skuFull, quantity, size, unitCost, false);
                }
            }
        }
    }

    console.log('Inventory update complete.');
}

// Run the update process
updateInventoryFromFetchedCSV();
