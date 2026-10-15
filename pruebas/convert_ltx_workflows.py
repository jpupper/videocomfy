"""
Convert LTX-2 ComfyUI workflows (with subgraphs) to API format.
This script properly handles subgraph definitions by flattening them.
"""
import json
import sys

def flatten_subgraph_workflow(workflow):
    """
    Takes a ComfyUI UI workflow with subgraph definitions and flattens it
    into a single-level API-format workflow.
    """
    api = {}
    
    # Collect subgraph definitions
    subgraphs = {}
    if 'definitions' in workflow and 'subgraphs' in workflow['definitions']:
        for sg in workflow['definitions']['subgraphs']:
            subgraphs[sg['id']] = sg
    
    # Build link map for top-level links
    top_links = {}
    for link in workflow.get('links', []):
        # link: [link_id, src_node, src_slot, dst_node, dst_slot, type]
        top_links[link[0]] = {
            'src_node': link[1],
            'src_slot': link[2],
            'dst_node': link[3],
            'dst_slot': link[4],
            'type': link[5] if len(link) > 5 else ''
        }
    
    # Build a map of node_id -> node for top-level
    top_nodes = {}
    for node in workflow.get('nodes', []):
        top_nodes[node['id']] = node
    
    # Process each top-level node
    for node in workflow.get('nodes', []):
        node_id = node['id']
        node_type = node['type']
        
        # Check if this node is a subgraph instance
        if node_type in subgraphs:
            sg = subgraphs[node_type]
            # Process the subgraph: flatten all its internal nodes
            
            # Build subgraph internal link map
            sg_links = {}
            for link in sg.get('links', []):
                sg_links[link['id']] = link
            
            # Map subgraph inputs to their sources from the top-level
            # sg['inputs'] defines the subgraph input ports
            # node['inputs'] (or widgets_values) feed into these
            sg_input_map = {}  # sg_input_id -> (source_node_id, source_slot)
            
            if 'inputs' in sg:
                for sg_input in sg['inputs']:
                    sg_input_id = sg_input['id']
                    # Find the corresponding top-level node input
                    for node_input in node.get('inputs', []):
                        if node_input['name'] == sg_input['name']:
                            if node_input.get('link') is not None:
                                link_info = top_links.get(node_input['link'])
                                if link_info:
                                    sg_input_map[sg_input_id] = (
                                        str(link_info['src_node']),
                                        link_info['src_slot']
                                    )
                            break
            
            # Map subgraph outputs
            sg_output_map = {}  # sg_output_id -> maps to output connections
            
            # Process each internal node
            for sg_node in sg.get('nodes', []):
                sg_node_id = sg_node['id']
                
                # Skip special nodes (-10 input, -20 output), MarkdownNote, Reroute
                if sg_node_id < 0:
                    continue
                if sg_node['type'] in ['MarkdownNote']:
                    continue
                    
                # Skip muted/bypassed nodes (mode 4)
                if sg_node.get('mode', 0) == 4:
                    continue
                
                # Use a prefixed ID to avoid collisions with top-level nodes
                api_node_id = f"sg_{node_id}_{sg_node_id}"
                
                api_node = {
                    'class_type': sg_node['type'],
                    'inputs': {},
                    '_meta': {'title': sg_node.get('title', sg_node['type'])}
                }
                
                # Process inputs
                widget_idx = 0
                widgets_values = sg_node.get('widgets_values', [])
                
                for inp in sg_node.get('inputs', []):
                    inp_name = inp['name']
                    
                    if inp.get('link') is not None:
                        link_id = inp['link']
                        link = sg_links.get(link_id)
                        if link:
                            src_id = link['origin_id']
                            src_slot = link['origin_slot']
                            
                            if src_id == -10:
                                # This is a subgraph input
                                # Find which input port
                                sg_input_defs = sg.get('inputs', [])
                                if src_slot < len(sg_input_defs):
                                    sg_inp = sg_input_defs[src_slot]
                                    sg_inp_id = sg_inp['id']
                                    
                                    if sg_inp_id in sg_input_map:
                                        # Connected to a top-level node
                                        api_node['inputs'][inp_name] = list(sg_input_map[sg_inp_id])
                                    else:
                                        # Connected to widget value from the parent node
                                        # Get the value from the parent node's widgets_values
                                        parent_widgets = node.get('widgets_values', [])
                                        # The order of widget values matches the order of subgraph inputs
                                        # that are widget-type (not connected)
                                        # We need to find the widget index for this particular input
                                        widget_order_idx = src_slot
                                        if widget_order_idx < len(parent_widgets):
                                            api_node['inputs'][inp_name] = parent_widgets[widget_order_idx]
                            else:
                                # Internal link - reference internal node
                                src_api_id = f"sg_{node_id}_{src_id}"
                                api_node['inputs'][inp_name] = [src_api_id, src_slot]
                    
                    elif 'widget' in inp:
                        # Widget input not connected by link - has a default value
                        if widget_idx < len(widgets_values):
                            api_node['inputs'][inp_name] = widgets_values[widget_idx]
                            widget_idx += 1
                
                # Process non-input widgets (those not in inputs list)
                # Count widget inputs to get proper widget_idx offset
                input_names = set(i['name'] for i in sg_node.get('inputs', []) if 'widget' in i)
                remaining_widgets = [w for w in widgets_values[len(input_names):]] if len(widgets_values) > len(input_names) else []
                
                api[api_node_id] = api_node
            
            # Handle Reroute nodes
            for sg_node in sg.get('nodes', []):
                if sg_node['type'] == 'Reroute' and sg_node.get('mode', 0) != 4:
                    sg_node_id = sg_node['id']
                    api_node_id = f"sg_{node_id}_{sg_node_id}"
                    # Find input link
                    for inp in sg_node.get('inputs', []):
                        if inp.get('link') is not None:
                            link = sg_links.get(inp['link'])
                            if link:
                                src_id = link['origin_id']
                                src_slot = link['origin_slot']
                                src_api_id = f"sg_{node_id}_{src_id}"
                                # Store reroute mapping
                                # For outputs that reference this reroute, redirect to source
                                # We'll handle this after all nodes are processed
        else:
            # Regular (non-subgraph) node
            if node_type in ['MarkdownNote']:
                continue
            if node.get('mode', 0) == 4:
                continue
                
            api_node = {
                'class_type': node_type,
                'inputs': {},
                '_meta': {'title': node.get('title', node_type)}
            }
            
            widget_idx = 0
            widgets_values = node.get('widgets_values', [])
            
            for inp in node.get('inputs', []):
                inp_name = inp['name']
                
                if inp.get('link') is not None:
                    link_info = top_links.get(inp['link'])
                    if link_info:
                        api_node['inputs'][inp_name] = [
                            str(link_info['src_node']),
                            link_info['src_slot']
                        ]
                elif 'widget' in inp:
                    if widget_idx < len(widgets_values):
                        api_node['inputs'][inp_name] = widgets_values[widget_idx]
                        widget_idx += 1
            
            api[str(node_id)] = api_node
    
    return api


def convert_file(input_path, output_path):
    with open(input_path, 'r', encoding='utf-8') as f:
        workflow = json.load(f)
    
    api = flatten_subgraph_workflow(workflow)
    
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(api, f, indent=2, ensure_ascii=False)
    
    print(f"Converted {input_path} -> {output_path}")
    print(f"Total nodes: {len(api)}")
    for k, v in api.items():
        print(f"  {k}: {v['class_type']}")


if __name__ == '__main__':
    if len(sys.argv) > 2:
        convert_file(sys.argv[1], sys.argv[2])
    else:
        # Convert both LTX-2 workflows
        convert_file('video_ltx2_t2v.json', 'video_ltx2_t2v_api.json')
        convert_file('video_ltx2_i2v.json', 'video_ltx2_i2v_api.json')
