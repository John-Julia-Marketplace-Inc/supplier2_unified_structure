from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
import pandas as pd
import os

# from dotenv import load_dotenv

# load_dotenv()

LOGIN = os.getenv('LOGIN')
PASSWORD = os.getenv('PASSWORD')
SUPPLIER_URL = os.getenv('SUPPLIER_URL')

def preprocess_sizes_quantities(data):
    info = []

    for d in data:
        info.append(', '.join([f'{k}: {v}' for k, v in d.items()]))

    return ';'.join(info)

def get_size_details(driver, dimensions):
    dim = dimensions.copy()
    
    try:
        size_fit_tab = WebDriverWait(driver, 20).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, 'a[data-bs-target="#tab-sizeandfit"]'))
        )
        driver.execute_script("arguments[0].scrollIntoView(true);", size_fit_tab)
        time.sleep(1)
        driver.execute_script("arguments[0].click();", size_fit_tab)
        
        WebDriverWait(driver, 20).until(
            EC.visibility_of_element_located((By.CSS_SELECTOR, 'div.tab-pane#tab-sizeandfit'))
        )
        
        size_and_fit = driver.find_element(By.CSS_SELECTOR, 'div.tab-pane#tab-sizeandfit').find_elements(By.TAG_NAME, 'li')
        for size in size_and_fit:
            if "Width" in size.text:
                dim["Width"] = size.text.split(" ")[1] + ' cm'
            elif "Height" in size.text:
                dim["Height"] = size.text.split(" ")[1] + ' cm'
            elif "Depth" in size.text:
                dim["Depth"] = size.text.split(" ")[1] + ' cm'
            elif "Handle drop" in size.text:
                dim["Handle Drop"] = size.text.split(" ")[2] + ' cm'
    except Exception as e:
        print(f"Error getting size details")
    
    return dim

def get_tab_info(driver, tab_id):
    try:
        # Wait for the tab content to be visible
        tab = WebDriverWait(driver, 2).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, f'a[data-bs-target="#{tab_id}"]'))
        )
        
        driver.execute_script("arguments[0].scrollIntoView(true);", tab)
        time.sleep(1)
        driver.execute_script("arguments[0].click();", tab)
        
        WebDriverWait(driver, 2).until(
            EC.visibility_of_element_located((By.CSS_SELECTOR, f'div.tab-pane#{tab_id}'))
        )
        
        tab = driver.find_element(By.CSS_SELECTOR, f'div.tab-pane#{tab_id}').find_elements(By.TAG_NAME, 'li')
        
        if tab:
            return '<br>'.join([x.text for x in tab])
        
        return []
    
    except Exception as e:
        return None

def get_size_and_fit_details(driver):
    # Extract details from both 'Size & Fit' and 'Details' tabs
    size_and_fit_info = get_tab_info(driver, 'tab-sizeandfit')
    details_info = get_tab_info(driver, 'tab-details')
    
    return size_and_fit_info, details_info


def get_table_data(driver):
    # Try first structure
    table_data_v1 = []

    try:
        # Locate the table body containing the items (Structure 1)
        tbody_v1 = driver.find_element(By.CSS_SELECTOR, 'tbody.cart.item')

        # Iterate over each row in the table (Structure 1)
        rows_v1 = tbody_v1.find_elements(By.CSS_SELECTOR, 'tr.item-info')

        for row in rows_v1:
            # Extract the size, quantity, price, and old price from the appropriate columns
            size = row.find_element(By.CSS_SELECTOR, 'td.first-attr span.attr-label').text
            quantity = row.find_element(By.CSS_SELECTOR, 'td:nth-of-type(2)').text
            price = row.find_element(By.CSS_SELECTOR, 'td:nth-of-type(3) div:first-of-type').text.strip()
            old_price = row.find_element(By.CSS_SELECTOR, 'td:nth-of-type(3) div.unit-old').text.strip()

            # Append data to the list for the first structure
            table_data_v1.append({
                'Size': size,
                'Quantity': quantity,
                'Price': price,
                'Old Price': old_price
            })
    except Exception as e:
        print(f"Structure 1 not found or has issues")
    
    # If first structure has data, return it
    if table_data_v1:
        return table_data_v1

    # Try second structure if first structure doesn't have data
    table_data_v2 = []
    
    try:
        # Locate the table body containing the items (Structure 2)
        tbody_v2 = driver.find_element(By.CSS_SELECTOR, 'tbody.cart.item')

        # Iterate over each row in the table (Structure 2)
        rows_v2 = tbody_v2.find_elements(By.CSS_SELECTOR, 'tr.item-info')

        for row in rows_v2:
            # Extract the size, quantity, price, and old price from the appropriate columns
            size = row.find_element(By.CSS_SELECTOR, 'td.first-attr span.attr-label').text
            quantity = row.find_element(By.CSS_SELECTOR, 'td:nth-of-type(2)').text
            price = row.find_element(By.CSS_SELECTOR, 'td:nth-of-type(3) div:first-of-type').text.strip()
            old_price = row.find_element(By.CSS_SELECTOR, 'td:nth-of-type(3) div.unit-old').text.strip()

            # Append data to the list for the second structure
            table_data_v2.append({
                'Size': size,
                'Quantity': quantity,
                'Price': price,
                'Old Price': old_price
            })
    except Exception as e:
        print(f"Structure 2 not found or has issues")
    
    # Return the second structure's data if it exists
    if table_data_v2:
        return table_data_v2

    # If neither structure has data, return an empty list
    return []


def get_general_info(driver):
    product_name = brand_name = product_image_links_str = color = country = description = None
    collection = sizes = quantities = breadcrumbs = None
    
    try:
        breadcrumb_elements = driver.find_elements(By.CSS_SELECTOR, 'div.breadcrumbs ul.items li')
        breadcrumbs = ' > '.join([breadcrumb.text.strip() for breadcrumb in breadcrumb_elements])
    except Exception as e:
        print(f"Error getting breadcrumbs")
    
    try:
        description = driver.find_element(By.ID, 'tab-description').text
    except Exception as e:
        print(f"Error getting product description")
    
    try:
        collection = driver.find_element(By.CLASS_NAME, 'product-season').text
    except Exception as e:
        print(f'Error getting collection')
    
    try:
        product_images = driver.find_elements(By.CSS_SELECTOR, 'div.single-image img')
        product_image_links = [img.get_attribute('data-image-full') for img in product_images][:4]
        product_image_links_str = ', '.join(product_image_links)
    except Exception as e:
        print(f"Error getting product images")

    try:
        brand_name = driver.find_element(By.CSS_SELECTOR, 'span.product-brand a').get_attribute('title')
    except Exception as e:
        print(f"Error getting brand name")

    try:
        product_name = driver.find_element(By.CSS_SELECTOR, 'span.product-name').text
    except Exception as e:
        print(f"Error getting product name")
    
    try: 
        discounted_cost = driver.find_element(By.XPATH, '/html/body/div[1]/main/div[2]/div/div[2]/div[2]/div/div[2]/div/span[1]/span/span/span').text
    except:
        discounted_cost = "N/A"

    try:
        not_discounted_cost = driver.find_element(By.XPATH, '/html/body/div[1]/main/div[2]/div/div[2]/div[2]/div/div[2]/div/span[3]/span/span/span').text
        price = not_discounted_cost
    except:
        not_discounted_cost = "N/A"
        
    try:
        if discounted_cost == "N/A" and not_discounted_cost == "N/A":
            price_element = driver.find_element(By.CSS_SELECTOR, 'div.product-info-price div.price-final_price span.price-wrapper span.price')
            if price_element:
                price = price_element.text.strip()
    except Exception as e:
        print(f"Error getting price")
    
    product_code = 'N/A'
    
    try:
        if product_code == "N/A":
            product_code_element = driver.find_element(By.CSS_SELECTOR, 'div.product-code.mt-5 span')
            product_code = product_code_element.text.split(":")[1].strip()
    except Exception as e:
        print(f"Error finding product code")

    stock_status = 'In Stock'
    try:
        stock_status = driver.find_element(By.CSS_SELECTOR, 'div.outofstockpdp').text
        stock_status = 'OUT OF STOCK'
    except:
        pass

    size_and_fit_info, details_info = get_size_and_fit_details(driver)
    sizes_and_quantities = get_table_data(driver)

        
    if discounted_cost != 'N/A':    
        return product_name, brand_name, product_image_links_str, discounted_cost, not_discounted_cost, product_code, details_info, size_and_fit_info, description, sizes_and_quantities, collection, breadcrumbs, stock_status
    else:
        return product_name, brand_name, product_image_links_str, price, price, product_code, details_info, size_and_fit_info, description, sizes_and_quantities, collection, breadcrumbs, stock_status


def parser(url, collection, pages):
    start, end, counter = None, None, None
    
    try:
        options = webdriver.ChromeOptions()
        options.add_argument("--headless=new")
        driver = webdriver.Chrome(options=options)
        
        driver.get(url)
        time.sleep(2)

        username_field = driver.find_element(By.NAME, 'login[username]')
        password_field = driver.find_element(By.NAME, 'login[password]')

        username_field.send_keys(LOGIN)
        password_field.send_keys(PASSWORD)
        password_field.send_keys(Keys.RETURN)
        time.sleep(2)
        
        start, end, counter = None, None, None
        
        if pages == 'all':
            url = url
        elif ',' in pages:
            start, end = pages.split(',')
            start, end = int(start), int(end)
            
            url = f'{url}?p={start}'
            counter = start
        else:
            url = f'{url}?p={pages}'

        driver.get(url)
        time.sleep(3)


        while True:
            WebDriverWait(driver, 2).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, 'ol.products.list.items.product-items.row'))
            )

            try:
                product_list = WebDriverWait(driver, 2).until(
                    EC.presence_of_element_located((By.CSS_SELECTOR, 'ol.products.list.items.product-items.row'))
                )
                product_items = product_list.find_elements(By.CSS_SELECTOR, 'li.item.product.product-item.pb-5.col-6.col-md-6.col-lg-3')
            except Exception as e:
                print(f"Error locating product items")
                return
                
            if counter:
                if counter > end:
                    break
            
            for item in product_items:
                try:
                    product_link = item.find_element(By.CSS_SELECTOR, 'a.product-item-link').get_attribute('href')
                    driver.execute_script("window.open(arguments[0]);", product_link)
                    driver.switch_to.window(driver.window_handles[-1])

                    WebDriverWait(driver, 2).until(
                        EC.presence_of_element_located((By.CSS_SELECTOR, 'div.single-image img'))
                    )
                    
                    product_name, brand_name, product_image_links_str, discounted_cost, not_discounted_cost, product_code, details, size_and_fit, description, sizes_and_quantities, collection, breadcrumbs, stock_status = get_general_info(driver)
                    
                    sizes_and_quantities = preprocess_sizes_quantities(sizes_and_quantities)
                    
                    pd.DataFrame({
                        'Product Title': [product_name.title()],
                        'SKU': [product_code],
                        'Vendor': [brand_name],
                        'Retail Price': [not_discounted_cost],
                        'Discounted Price': [discounted_cost],
                        'Breadcrumbs': [breadcrumbs],
                        'Details': [details],
                        'Size and Fit': [size_and_fit],
                        'Description': [description],
                        'Collection': [collection],
                        'Sizes and Quantities': [sizes_and_quantities],
                        'Stock Status': [stock_status],
                        'Images': product_image_links_str
                    }).to_csv(filename, header=not os.path.exists(filename), mode='a', index=False)
                    
                    driver.close()
                    driver.switch_to.window(driver.window_handles[0])

                except Exception as e:
                    print(f"Error processing product")
                    driver.close()
                    driver.switch_to.window(driver.window_handles[0])
                    continue

            try:
                next_button = WebDriverWait(driver, 2).until(
                    EC.element_to_be_clickable((By.CSS_SELECTOR, 'li.pages-item-next > a.action.next'))
                )
                next_button_href = next_button.get_attribute('href')
                driver.get(next_button_href)
                time.sleep(5)

            except Exception as e:
                print("No more pages or error navigating to the next page")
                break
            
            if start and end:
                counter += 1
    except:
        print('Error connecting to the website...')
        return
    finally:
        if driver:
            driver.quit()
    
def fix_qty(row):
    if row['Qty'] == '0' or row['Qty'] == 0:
        return ','.join(['0' for _ in range(len(row['Size'].split(',')))])
    return row['Qty']

def setup():
    global filename
    
    folder = None
    
    if 'jewelry' in filename:
        folder = 'jewelry'
    elif 'women_shoes' in filename or 'woman_shoes' in filename:
        folder = 'women_shoes'
    elif 'men_shoes' in filename or 'man_shoes' in filename:
        folder = 'men_shoes'
    elif 'women_clothing' in filename or 'women_clothes' in filename:
        folder = 'women_clothing'
    elif 'men_clothing' in filename or 'men_clothes' in filename:
        folder = 'men_clothing'
    elif 'women_belts' in filename:
        folder = 'women_belts'
    elif 'men_belts' in filename:
        folder = 'men_belts'
    elif 'sunglasses' in filename:
        folder = 'sunglasses'
    elif 'bags':
        folder = 'bags'
    
    else: 
        raise KeyError(f'Could not find the category: {filename}')
    
    folder = f'private_repo/clean_data/{folder}'
    
    if not os.path.exists(folder):
        os.makedirs(folder)
    
    filename = f'{folder}/{filename}'

    if os.path.exists(filename):
        os.remove(filename)
            
    return folder, filename
    
if __name__ == "__main__":    
    import argparse
    start_time = time.time()

    # Setting up argument parser
    arg_parser = argparse.ArgumentParser(description="Web Scraper for collections")
    arg_parser.add_argument('--filename', type=str, help='File name', required=True)
    arg_parser.add_argument('--pages', type=str, nargs='+', help="List of pages to scrape", required=True)
    arg_parser.add_argument('--urls', type=str, nargs='+', help="List of URLs to scrape", required=True)
    arg_parser.add_argument('--n_collections', type=int, default=1, help='Number of collections', required=True)
    arg_parser.add_argument('--collection', type=str, help='Collection name', required=True)
    arg_parser.add_argument('--max_workers', type=int, default=6, help="Number of threads for concurrent execution")

    # Parse the command-line arguments
    args = arg_parser.parse_args()

    # Extract arguments
    filename = args.filename
    pages = args.pages
    n_collections = args.n_collections
    urls = [f'{SUPPLIER_URL}/{x}' for x in args.urls] * n_collections
    max_workers = args.max_workers
    collections = [args.collection] * n_collections
    
    if n_collections != len(pages):
        raise ValueError(f'Number of pages and collections do not equal! #Pages: {len(pages)}, #Collections: {n_collections}')
    
    if not (len(pages) == len(urls)):
        raise ValueError("The number of collections, pages, and URLs must be the same.")

    
    folder_loc, fname = setup()
    
    print(f"""
          ====================
          Starting the scraper
          ====================
          
          Folder location: {folder_loc}
          Filename: {fname}
          Number of Pages: {len(pages)}
          Number of Collections: {n_collections}
          Pages: {pages}
          """)
    
    # Execute the scraper with concurrent threads
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(parser, url, collection, page) for url, collection, page in zip(urls, collections, pages)]
        for future in as_completed(futures):
            try:
                future.result()
            except Exception as e:
                print(f"Issues with starting the scaper")

    end_time = time.time()  
    execution_time = end_time - start_time

    print(f"Start time: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(start_time))}")
    print(f"End time: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(end_time))}")
    print(f"Total execution time: {execution_time:.2f} seconds")