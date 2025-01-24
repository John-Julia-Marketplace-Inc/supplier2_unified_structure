import pandas as pd
import argparse

if __name__ == '__main__':
    
    # Setting up argument parser
    arg_parser = argparse.ArgumentParser(description="Preprocess data")
    arg_parser.add_argument('--input_folder', type=str, help='Folder name', required=True)
    arg_parser.add_argument('--clean_file', type=str, help='Clean file', required=True)
    
    # Parse the command-line arguments
    args = arg_parser.parse_args()

    # Extract arguments
    input_folder = args.input_folder
    clean_file = args.clean_file
    
    all_data = pd.read_csv(f'{input_folder}/{clean_file}')
    all_skus = pd.read_csv(f'{input_folder}/all_skus.csv')
    shopify_data = pd.read_csv(f'{input_folder}/shopify_data.csv')
    to_add_skus = pd.read_csv(f'{input_folder}/to_add.csv')
    
    # get new products to add
    new_products = all_data[all_data['SKU'].isin(to_add_skus['SKU'])]
    new_products[new_products['Size'] == 'OS'].to_csv(f'{input_folder}/os_add_products.csv', index=False)
    new_products[new_products['Size'] == 'OS'].to_csv(f'{input_folder}/others_add_products.csv', index=False)
    
    # get zero inventory products
    zero_inventory = all_skus[~all_skus['SKU'].isin(all_data['SKU'])]
    zero_inventory.to_csv(f'{input_folder}/zero_inventory_shopify.csv', index=False)
    
    # get products to update
    all_data_expanded = all_data[['SKU', 'Size', 'Qty']].assign(
            Size=all_data['Size'].str.split(','),
            Qty=all_data['Qty'].str.split(',')
        )
    all_data_expanded = all_data_expanded.explode(['Size', 'Qty'])
    
    shopify_data.columns = ['SKU', 'Size', 'Qty', 'Unit Cost']
    
    data_expanded = shopify_data[['SKU','Size','Qty']].assign(
            Size=shopify_data['Size'].str.split(';'),
            Qty=shopify_data['Qty'].str.split(';')
        )

    data_expanded = data_expanded.explode(['Size', 'Qty'])
    
    all_data_expanded.columns = data_expanded.columns
    merged_df = data_expanded.merge(all_data_expanded, on=['SKU', 'Size'], suffixes=('_shopify', '_supplier'))
    diff_df = merged_df[merged_df['Qty_shopify'] != merged_df['Qty_supplier']]
    diff_df.to_csv(f'{input_folder}/os_update_products.csv', index=False)
    
    # get different unit costs
    data = all_data[['SKU', 'Unit Cost']]
    shopify = shopify_data[['SKU', 'Unit Cost']]
    shopify.columns = data.columns
    combined = shopify.merge(data, on='SKU', suffixes=('_shopify', '_supplier'))
    combined[combined['Unit Cost_shopify'] != combined['Unit Cost_supplier']].to_csv(f'{input_folder}/different_costs.csv', index=False)
    
    
    
    
    