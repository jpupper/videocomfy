import json
import sys

def convert_workflow_to_api(workflow_path, output_path):
    """
    Convierte un workflow de ComfyUI (formato UI) al formato API
    """
    with open(workflow_path, 'r', encoding='utf-8') as f:
        workflow = json.load(f)
    
    api_workflow = {}
    
    # Convertir cada nodo
    for node in workflow['nodes']:
        node_id = str(node['id'])
        api_workflow[node_id] = {
            'class_type': node['type'],
            'inputs': {}
        }
        
        # Procesar inputs
        if 'inputs' in node:
            widget_index = 0
            for input_def in node['inputs']:
                input_name = input_def['name']
                
                # Si tiene un link, es una conexión a otro nodo
                if input_def.get('link') is not None:
                    # Buscar el link en la lista de links
                    link_id = input_def['link']
                    for link in workflow['links']:
                        if link[0] == link_id:
                            # link format: [link_id, source_node_id, source_output_index, target_node_id, target_input_index, type]
                            source_node = str(link[1])
                            source_output = link[2]
                            api_workflow[node_id]['inputs'][input_name] = [source_node, source_output]
                            break
                
                # Si es un widget (tiene valores)
                elif 'widget' in input_def:
                    if 'widgets_values' in node and widget_index < len(node['widgets_values']):
                        api_workflow[node_id]['inputs'][input_name] = node['widgets_values'][widget_index]
                        widget_index += 1
    
    # Guardar el workflow convertido
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(api_workflow, f, indent=2, ensure_ascii=False)
    
    print(f"Workflow convertido exitosamente: {output_path}")
    return api_workflow

if __name__ == '__main__':
    if len(sys.argv) > 1:
        input_file = sys.argv[1]
        output_file = sys.argv[2] if len(sys.argv) > 2 else 'workflow_api_converted.json'
    else:
        input_file = 'uisatocomfy.json'
        output_file = 'uisatocomfy_api.json'
    
    convert_workflow_to_api(input_file, output_file)
